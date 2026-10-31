import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ServerNotification,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { TokenCredential } from '@azure/identity';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { credentialProcessTimeout } from './auth/process-timeout.js';
import { createTokenCredential } from './auth/token-credentials.js';
import {
  carryNotQueryFault,
  formatKustoMcpError,
  getFailureCategory,
  isKustoMcpError,
  isNotQueryFault,
  KustoAuthenticationError,
  KustoConnectionError,
  KustoQueryCancelledError,
  KustoTimeoutError,
  KustoValidationError,
  setFailureCategory,
  withTimeoutHint,
} from './common/errors.js';
import { criticalLog, debugLog } from './common/utils.js';
import {
  autoConnectKey,
  beginAutoConnect,
  clearAutoConnectBackoff,
} from './common/autoconnect-backoff.js';
import {
  clientNameForTelemetry,
  clientVersionForTelemetry,
} from './common/client-info.js';
import { getIdentityAttributes } from './common/identity.js';
import {
  SeverityNumber,
  carryErrorRecording,
  emitLog,
  errorTypeName,
  flushLogs,
  recordSpanError,
  responseBytesHistogram,
  queryRowsHistogram,
  toolCallsCounter,
  toolDurationHistogram,
  toolErrorsCounter,
  toolNotInitializedCounter,
} from './common/telemetry.js';
import { appendRowLimit, assertQueryAllowed } from './common/kql-safety.js';
import { classifyPurpose, QUERY_PURPOSES } from './common/query-purpose.js';
import { classifyQueryShape } from './common/query-shape.js';
import {
  failureStreakBucket,
  QueryResult,
  SessionTracker,
} from './common/session-tracker.js';
import { VERSION } from './common/version.js';
import {
  executeQuery,
  KustoConnection,
  showFunction,
  showTable,
  showTables,
} from './operations/kusto/index.js';
import { showFunctions } from './operations/kusto/tables.js';
import { buildReportIssueUrl } from './operations/github/index.js';
import { PromptManager } from './operations/prompts/index.js';
import { KustoConfig, validateConfig } from './types/config.js';

// Define schemas for tool parameters
const InitializeConnectionSchema = z.object({
  cluster_url: z.string().describe('The URL of the Kusto cluster'),
  database: z.string().describe('The database to connect to'),
});

const ShowTablesSchema = z.object({});
const ShowFunctionsSchema = z.object({});

const ShowTableSchema = z.object({
  tableName: z.string().describe('The name of the table to get the schema for'),
});

const ExecuteQuerySchema = z.object({
  // Declared first so models fill it before writing the query. Deliberately a
  // plain string, not an enum: telemetry must never reject or alter a call.
  // Non-strings are dropped; unlisted strings are handled by classifyPurpose.
  purpose: z
    .string()
    .optional()
    .catch(undefined)
    .describe(
      `Optional analytics hint: why you are running this query, e.g. ${QUERY_PURPOSES.join(', ')}. Omit if unsure. Never put query text or names here.`,
    ),
  query: z.string().describe('The query to execute'),
  limit: z
    .number()
    .optional()
    .default(20)
    .describe('Maximum number of rows to return (default: 20)'),
});

const PROGRESS_INTERVAL_MS = 15000;

/**
 * Send notifications/progress every PROGRESS_INTERVAL_MS until the returned
 * stop function is called. No-op without a progressToken. Never throws.
 */
function startProgressHeartbeat(
  progressToken: string | number | undefined,
  sendNotification: (n: ServerNotification) => Promise<void>,
): () => void {
  if (progressToken === undefined) return () => {};
  const startedAt = Date.now();
  let ticks = 0;
  const timer = setInterval(() => {
    try {
      ticks++;
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken,
          progress: ticks,
          message: `Query running (${seconds}s)`,
        },
      }).catch(() => {});
    } catch {
      // Progress is best-effort.
    }
  }, PROGRESS_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

const ShowFunctionSchema = z.object({
  functionName: z
    .string()
    .describe('The name of the function to get details for'),
});

const ReportIssueSchema = z.object({
  title: z
    .string()
    .min(1)
    .max(256)
    .describe('Short summary line for the GitHub issue'),
  body: z
    .string()
    .optional()
    .describe(
      'Full description (Markdown): what happened, expected vs actual behavior, and steps to reproduce.',
    ),
  labels: z
    .array(z.string())
    .optional()
    .describe("Labels to pre-select, e.g. ['bug'] or ['enhancement']."),
  includeDiagnostics: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      'Append non-sensitive environment info (kusto-mcp/node/OS/MCP-client versions, connection state, response format, write mode). Never includes cluster URL, database, identity, query text, or results.',
    ),
});

// Appended to execute-query errors once this many failed in a row (#313).
const QUERY_FAILURE_HINT_AFTER = 3;
const QUERY_FAILURE_HINT =
  'Several queries failed in a row – check the table schema with show-table and simplify the query.';

// Added to a successful execute-query that returned no rows.
const EMPTY_RESULT_HINT =
  'No rows matched. If this is unexpected, check the datetime() range and filter values (e.g. case, exact IDs) before concluding there is no data.';

// 1 -> "1st", 3 -> "3rd", 11 -> "11th", 22 -> "22nd".
const ORDINAL_RULES = new Intl.PluralRules('en-US', { type: 'ordinal' });
const ORDINAL_SUFFIX: Record<string, string> = {
  one: 'st',
  two: 'nd',
  few: 'rd',
  other: 'th',
};
function ordinal(n: number): string {
  return `${n}${ORDINAL_SUFFIX[ORDINAL_RULES.select(n)] ?? 'th'}`;
}

/**
 * Create a Kusto MCP server
 *
 * @param config The Kusto configuration
 * @returns A configured MCP server instance
 */
const serverTracer = trace.getTracer('kusto-mcp-server');

/** Extra wait past connectionTimeout for the startup auto-connect to settle. */
export const AUTO_CONNECT_WAIT_GRACE_MS = 1000;

export function createKustoServer(config: KustoConfig): Server {
  // Validate the configuration
  const validatedConfig = validateConfig(config);

  // Initialize the MCP server
  const server = new Server(
    {
      name: 'kusto-mcp',
      version: VERSION,
    },
    {
      capabilities: {
        tools: {},
        ...(validatedConfig.enablePrompts && { prompts: {} }),
      },
    },
  );

  // Declare a variable to store the connection when it's initialized
  let connection: KustoConnection | null = null;

  // One credential (and token cache) for every connection this process
  // makes: a retry after a failed auto-connect, or a reconnect, reuses the
  // tokens already fetched instead of running `az` again. Built on first
  // use, where KustoConnection used to build its own (it may throw).
  let sharedCredential: TokenCredential | undefined;
  const processCredential = (): TokenCredential =>
    (sharedCredential ??= createTokenCredential(
      validatedConfig.authMethod,
      credentialProcessTimeout(validatedConfig.connectionTimeout ?? 20000),
    ));

  // Bounded per-process behavior signals (previous tool, retry class, ...).
  const session = new SessionTracker();

  // Initialize the prompt manager
  const promptManager = validatedConfig.enablePrompts
    ? new PromptManager()
    : null;

  // Bumped by every initialize-connection call. An auto-connect only stores
  // its result if no manual connect started meanwhile, so manual always wins.
  let manualConnectCount = 0;

  // Which initialize-connection call `connection` came from (its
  // manualConnectCount value; 0 = none or the auto-connect).
  let connectionGeneration = 0;

  // Manual connects still running, keyed by cluster + database (#290).
  // `generation` is the count of the newest call waiting on it.
  type ManualConnect = {
    generation: number;
    promise: Promise<Awaited<ReturnType<KustoConnection['initialize']>>>;
  };
  const manualConnects = new Map<string, ManualConnect>();

  // Release a connection that never became `connection`. Never throws.
  function discardConnection(conn: KustoConnection): void {
    try {
      if (typeof conn.close === 'function') conn.close();
    } catch {
      /* best effort */
    }
  }

  // Run one manual connect and store it only once it works, so a failed
  // connect never replaces a working one (#290). With several running at
  // once, the newest initialize-connection call that succeeds wins, whatever
  // the order they finish in: a connect stores its result only if no newer
  // call's connect already did.
  async function runManualConnect(
    clusterUrl: string,
    database: string,
    entry: { generation: number },
  ) {
    const candidate = new KustoConnection(validatedConfig, processCredential());
    const result = await candidate
      .initialize(clusterUrl, database, 'manual', connection)
      .catch(error => {
        manualConnectFailed = true;
        throw error;
      });
    autoConnectPaused = false;
    clearAutoConnectBackoff();
    if (entry.generation > connectionGeneration) {
      // Not closed: queries already running may still hold the old client.
      connection = candidate;
      connectionGeneration = entry.generation;
    } else {
      debugLog('Manual connection discarded: a newer one is already in use');
      discardConnection(candidate);
    }
    return result;
  }

  // The startup auto-connect while it is still running; null once it settles.
  let autoConnectInFlight: Promise<void> | null = null;

  // Why the startup auto-connect failed, shown on later "not initialized"
  // errors (#315). In-process only; never exported.
  let autoConnectFailure: string | null = null;
  // Set when this launch skipped the startup auto-connect because earlier
  // launches kept failing (#316). Cleared by a successful manual connect.
  let autoConnectPaused = false;
  // Tool calls rejected as "not initialized". A connection is never dropped
  // once made, so these are always consecutive. Agents that never call
  // initialize-connection keep retrying; from the third rejection the error
  // tells them to stop. In-process only; never exported.
  let notInitializedCount = 0;
  // Set once an initialize-connection call fails, so the stop-retrying
  // error points at the failed connect instead of asking for one.
  let manualConnectFailed = false;

  // Auto-connection function
  async function tryAutoConnect(): Promise<void> {
    // Only attempt auto-connection if both cluster URL and database are configured
    if (!validatedConfig.clusterUrl || !validatedConfig.defaultDatabase) {
      debugLog(
        'Auto-connection skipped: missing cluster URL or database configuration',
      );
      return;
    }

    const backoff = beginAutoConnect(
      autoConnectKey(
        validatedConfig.clusterUrl,
        validatedConfig.defaultDatabase,
        String(validatedConfig.authMethod),
      ),
    );
    if (backoff.skip) {
      autoConnectPaused = true;
      criticalLog(
        `Auto-connection paused after repeated failures; next attempt in ~${Math.ceil(backoff.retryInMs / 1000)}s on a later launch. Call initialize-connection to connect now.`,
      );
      emitLog(SeverityNumber.INFO, 'INFO', 'Auto-connection skipped', {
        'kustomcp.connection.autoconnect': 'skipped_backoff',
      });
      // Hosts that relaunch in a loop may kill this launch within the 1s
      // log batch; export the skip now so the launch leaves a trace.
      void flushLogs();
      return;
    }

    const manualCountAtStart = manualConnectCount;
    try {
      debugLog(
        `Attempting auto-connection to ${validatedConfig.clusterUrl} -> ${validatedConfig.defaultDatabase}`,
      );

      // Create a new connection
      const autoConnection = new KustoConnection(
        validatedConfig,
        processCredential(),
      );

      // Initialize the connection
      const result = await autoConnection.initialize(
        validatedConfig.clusterUrl,
        validatedConfig.defaultDatabase,
        'auto',
      );
      clearAutoConnectBackoff();

      // A manual connect started while this was pending wins.
      if (manualConnectCount !== manualCountAtStart) {
        debugLog('Auto-connection result discarded: manual connection made');
        discardConnection(autoConnection);
        return;
      }

      // If successful, store the connection
      connection = autoConnection;
      criticalLog(
        `Auto-connection successful: ${result.cluster} -> ${result.database}`,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      criticalLog(
        `Auto-connection failed: ${errorMessage}. Manual connection will be required.`,
      );
      if (manualConnectCount === manualCountAtStart) {
        autoConnectFailure = errorMessage.replace(/^Connection error: /, '');
      }
      // Don't throw - just log and continue with manual connection mode
    }
  }

  // If the startup auto-connect is still running, wait for it, bounded by the
  // connection timeout so a hung connect can't block the call forever. Never
  // starts a new attempt: once the startup one has failed (or none was
  // configured), the call fails right away as before.
  async function awaitAutoConnect(): Promise<void> {
    const pending = autoConnectInFlight;
    if (connection || !pending) {
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>(resolve => {
      // initialize() is itself bounded by connectionTimeout (probe included);
      // the grace lets a failure finishing right at that bound record its reason.
      timer = setTimeout(
        resolve,
        (validatedConfig.connectionTimeout ?? 20000) +
          AUTO_CONNECT_WAIT_GRACE_MS,
      );
      timer.unref?.();
    });
    try {
      await Promise.race([pending, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  // Register the ListTools request handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'initialize-connection',
          description: 'Creates connection to an ADX cluster',
          inputSchema: z.toJSONSchema(InitializeConnectionSchema),
        },
        {
          name: 'show-tables',
          description: 'List tables in the current database',
          inputSchema: z.toJSONSchema(ShowTablesSchema),
        },
        {
          name: 'show-table',
          description: 'Show the table schema columns',
          inputSchema: z.toJSONSchema(ShowTableSchema),
        },
        {
          name: 'execute-query',
          description:
            'Runs KQL queries and returns results. ' +
            (validatedConfig.clusterUrl && validatedConfig.defaultDatabase
              ? ''
              : validatedConfig.clusterUrl
                ? 'No database is configured, so nothing connects at startup: call initialize-connection before the first query. '
                : 'No cluster is configured: call initialize-connection before the first query. ') +
            'If you have not inspected the table yet, call show-table first to see its columns. By default, limits results to 20 rows to prevent context overflow. Use the "limit" parameter to specify a different maximum. If results are marked as partial, consider revising your query to use aggregations, filters, or summarizations. Avoid the search operator on large tables; it often times out. Filter a specific table with where/has instead. Optionally set "purpose" to the closest intent.',
          inputSchema: z.toJSONSchema(ExecuteQuerySchema),
        },
        {
          name: 'show-functions',
          description: 'List functions in the current database',
          inputSchema: z.toJSONSchema(ShowFunctionsSchema),
        },
        {
          name: 'show-function',
          description:
            'Show details of a specific function, including its code and parameters',
          inputSchema: z.toJSONSchema(ShowFunctionSchema),
        },
        {
          name: 'report-issue',
          description:
            'Report a bug or request a feature for kusto-mcp on GitHub. Returns a pre-filled GitHub issue link you open in your browser and submit under your own GitHub account — no GitHub token is used or stored, and no Kusto connection is required.',
          inputSchema: z.toJSONSchema(ReportIssueSchema),
        },
      ],
    };
  });

  // Register the prompt handlers only when prompts are enabled. The MCP SDK
  // refuses to register a handler for a capability the server did not
  // declare, so registering them unconditionally crashes startup when
  // prompts are disabled.
  if (promptManager) {
    registerPromptHandlers(server, promptManager);
  }

  // Register the CallTool request handler
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const toolName = request.params.name;
    return serverTracer.startActiveSpan(`mcp.tool/${toolName}`, async span => {
      const startedAt = Date.now();
      // Also stamped on the span as kustomcp.tool.status.
      let status: 'ok' | 'error' | 'cancelled' = 'ok';
      // Facts about an execute-query call, fed to the session tracker in finally.
      let queryFacts:
        { limit: number; partial: boolean; rowCount?: number } | undefined;
      let queryReduced = false;
      let finishQuery: ((r: QueryResult) => void) | undefined;
      // Which shipped hint, if any, was appended to an execute-query result.
      let hintFired:
        | 'none'
        | 'failure_streak'
        | 'timeout'
        | 'empty_result'
        | 'not_initialized_stop' = 'none';

      span.setAttribute('kustomcp.tool.name', toolName);
      // MCP client (host app) identity — a first-order "who uses this" signal.
      // Bounded: a known product name or 'other' (see client-info.ts).
      const clientInfo = server.getClientVersion();
      const clientName = clientNameForTelemetry(clientInfo?.name);
      const clientVersion = clientVersionForTelemetry(
        clientInfo?.version,
        clientInfo?.name,
      );
      if (clientName) span.setAttribute('mcp.client.name', clientName);
      if (clientVersion) span.setAttribute('mcp.client.version', clientVersion);
      // Argument KEYS only — never values (may contain sensitive data).
      if (request.params.arguments) {
        span.setAttribute(
          'kustomcp.tool.arg_keys',
          Object.keys(request.params.arguments).join(','),
        );
      }
      // Anonymous cohort hashes (user_hash / company_hash) for distinct counts.
      for (const [k, v] of Object.entries(getIdentityAttributes())) {
        if (v !== undefined && v !== null) span.setAttribute(k, v);
      }

      // Require an initialized connection; records the not_initialized metric.
      const requireConnection = async (): Promise<KustoConnection> => {
        await awaitAutoConnect();
        if (!connection) {
          toolNotInitializedCounter.add(1, { tool: toolName });
          notInitializedCount++;
          // From the third rejection in a row, tell the agent to stop retrying.
          const attempt =
            notInitializedCount >= 3
              ? ` (${ordinal(notInitializedCount)} attempt without connecting)`
              : '';
          const stop = !attempt
            ? ''
            : manualConnects.size > 0
              ? ` Stop retrying ${toolName}: initialize-connection is still running, so wait for it to finish.`
              : manualConnectFailed
                ? ` Stop retrying ${toolName}: initialize-connection failed, so fix the cluster URL or auth and call it again.`
                : ` Stop retrying ${toolName}: call initialize-connection with a cluster URL first.`;
          if (stop) hintFired = 'not_initialized_stop';
          if (autoConnectPaused) {
            span.setAttribute(
              'kustomcp.connection.autoconnect',
              'skipped_backoff',
            );
            const paused = new McpError(
              ErrorCode.InvalidRequest,
              `Connection not initialized${attempt}: auto-connect is paused after repeated failed attempts at startup.${stop || ' Please call initialize-connection to connect.'}`,
            );
            setFailureCategory(paused, 'not_connected');
            throw paused;
          }
          const reason = autoConnectFailure
            ? `\nThe startup auto-connect to ${validatedConfig.clusterUrl} (database '${validatedConfig.defaultDatabase}') failed: ${autoConnectFailure}`
            : '';
          const notConnected = new McpError(
            ErrorCode.InvalidRequest,
            attempt
              ? `Connection not initialized${attempt}.${stop}${reason}`
              : `Connection not initialized. Please call initialize-connection first.${reason}`,
          );
          setFailureCategory(notConnected, 'not_connected');
          throw notConnected;
        }
        return connection;
      };

      try {
        const result = await (async () => {
          // execute-query checks this itself so the failure keeps its
          // invalid-args telemetry (#318).
          if (!request.params.arguments && toolName !== 'execute-query') {
            throw new McpError(
              ErrorCode.InvalidParams,
              'Arguments are required',
            );
          }

          switch (request.params.name) {
            case 'initialize-connection': {
              const args = InitializeConnectionSchema.parse(
                request.params.arguments,
              );

              manualConnectCount++;
              autoConnectFailure = null;

              // Same cluster + database as a connect still running: wait for
              // that one instead of starting another (#290). Joining makes it
              // count as this, newer, call.
              const key = `${args.cluster_url}\n${args.database}`;
              let pending = manualConnects.get(key);
              span.setAttribute(
                'kustomcp.connection.shared_inflight',
                pending !== undefined,
              );
              if (pending) {
                pending.generation = manualConnectCount;
              } else {
                const entry = {
                  generation: manualConnectCount,
                } as ManualConnect;
                entry.promise = runManualConnect(
                  args.cluster_url,
                  args.database,
                  entry,
                ).finally(() => {
                  if (manualConnects.get(key) === entry) {
                    manualConnects.delete(key);
                  }
                });
                manualConnects.set(key, entry);
                pending = entry;
              }

              const result = await pending.promise;
              return {
                content: [
                  { type: 'text', text: JSON.stringify(result, null, 2) },
                ],
              };
            }

            case 'show-tables': {
              ShowTablesSchema.parse(request.params.arguments);
              const result = await showTables(await requireConnection());
              return {
                content: [
                  { type: 'text', text: JSON.stringify(result, null, 2) },
                ],
              };
            }

            case 'show-table': {
              const args = ShowTableSchema.parse(request.params.arguments);
              const result = await showTable(
                await requireConnection(),
                args.tableName,
              );
              return {
                content: [
                  { type: 'text', text: JSON.stringify(result, null, 2) },
                ],
              };
            }

            case 'show-functions': {
              ShowFunctionsSchema.parse(request.params.arguments);
              const result = await showFunctions(await requireConnection());
              return {
                content: [
                  { type: 'text', text: JSON.stringify(result, null, 2) },
                ],
              };
            }

            case 'execute-query': {
              const rawArgs = request.params.arguments ?? {};
              // The schema defaults `limit` to 20, so tell "omitted" from an
              // explicit 20 by the raw key (#318).
              span.setAttribute(
                'kustomcp.query.limit_explicit',
                rawArgs.limit !== undefined,
              );
              let args: z.infer<typeof ExecuteQuerySchema>;
              try {
                if (!request.params.arguments) {
                  throw new McpError(
                    ErrorCode.InvalidParams,
                    'Arguments are required',
                  );
                }
                args = ExecuteQuerySchema.parse(rawArgs);
              } catch (error) {
                // Invalid arguments still carry the bounded intent, shape and
                // session dimensions (#318). See peekQuery for why an invalid
                // call does not count as a query in the session signals.
                span.setAttribute('kustomcp.query.outcome', 'invalid_args');
                span.setAttributes(session.peekQuery());
                span.setAttribute(
                  'kustomcp.declared.purpose',
                  classifyPurpose(rawArgs.purpose).purpose,
                );
                if (typeof rawArgs.query === 'string') {
                  span.setAttributes(classifyQueryShape(rawArgs.query));
                }
                throw error;
              }
              const requestedLimit = args.limit || 20;
              // Record the limit and stamp the input-derived attributes before
              // any check that can throw (connection, read-only, execution), so
              // failed calls carry the same intent/session dimensions.
              queryFacts = { limit: requestedLimit, partial: false };

              // Intent / shape / behavior telemetry. Query shape and session
              // signals are closed-vocabulary. `purpose` is an optional label:
              // known values and common synonyms are reported as the listed
              // label; any other value the caller
              // chose is exported verbatim as `purpose_unlisted` (maintainer's
              // decision, so new categories can be discovered). Each helper is
              // failure-safe.
              span.setAttribute(
                'kustomcp.query.requested_limit',
                requestedLimit,
              );
              const declared = classifyPurpose(args.purpose);
              span.setAttribute('kustomcp.declared.purpose', declared.purpose);
              if (declared.unlisted) {
                span.setAttribute(
                  'kustomcp.declared.purpose_unlisted',
                  declared.unlisted,
                );
              }
              span.setAttributes(classifyQueryShape(args.query));
              const queryTicket = session.beginQuery(requestedLimit);
              span.setAttributes(queryTicket.attributes);
              finishQuery = queryTicket.finish;

              const conn = await requireConnection();

              // Enforce read-only mode unless writes are explicitly enabled.
              try {
                assertQueryAllowed(
                  args.query,
                  validatedConfig.allowWriteOperations ?? false,
                );
              } catch (error) {
                span.addEvent('read_only_violation');
                emitLog(SeverityNumber.WARN, 'WARN', 'Read-only violation', {
                  'kustomcp.tool.name': 'execute-query',
                  'kustomcp.write_allowed': false,
                });
                throw error;
              }

              // Global response limit
              const globalCharLimit =
                validatedConfig.maxResponseLength || 12000;
              const minRows = validatedConfig.minRowsInResponse || 1;

              // Fetch one extra row (N+1) so we can detect whether more data is
              // available than the requested limit. The `take` is appended on a
              // new line so it doesn't merge into a trailing line comment, and is
              // skipped for control commands (".show ..."), which don't accept a
              // piped `| take`. Per Kusto semantics, when the query is sorted the
              // top rows are returned, so ordering is preserved.
              const initialLimit = requestedLimit;
              const modifiedQuery = appendRowLimit(
                args.query,
                initialLimit + 1,
              );

              // Import the transformation function here to avoid auto-formatter issues
              const { transformQueryResult } =
                await import('./operations/kusto/index.js');
              const { limitResponseSize } =
                await import('./common/response-limiter.js');

              // Execute the query and get raw results
              // extra.signal aborts on notifications/cancelled from the client.
              // While it runs, send progress so hosts that extend their own
              // request timeout on progress keep the call alive.
              // A timeout here (ours or the server's) gets recovery advice
              // for the agent (#312). Only execute-query: the show-* tools run
              // fixed metadata queries with no time range to narrow.
              const stopProgress = startProgressHeartbeat(
                request.params._meta?.progressToken,
                extra.sendNotification,
              );
              let rawResult;
              try {
                rawResult = await executeQuery(
                  conn,
                  modifiedQuery,
                  extra.signal,
                ).catch((error: unknown) => {
                  if (!(error instanceof KustoTimeoutError)) throw error;
                  const hinted = new KustoTimeoutError(
                    withTimeoutHint(error.message, args.query),
                  );
                  if (hinted.message !== error.message) hintFired = 'timeout';
                  carryErrorRecording(error, hinted);
                  carryNotQueryFault(error, hinted);
                  throw hinted;
                });
              } finally {
                stopProgress();
              }

              // Transform using the proper architecture
              const transformedResult = transformQueryResult(
                rawResult,
                validatedConfig,
              );

              // Detect if results are partial using N+1 approach
              const hasMoreDataAvailable =
                transformedResult.data.length > initialLimit;
              const availableData = hasMoreDataAvailable
                ? transformedResult.data.slice(0, initialLimit)
                : transformedResult.data;

              const isPartial =
                hasMoreDataAvailable || availableData.length > requestedLimit;

              // Result-shape telemetry (no row values, only counts/flags).
              span.setAttribute(
                'kustomcp.result.row_count',
                availableData.length,
              );
              span.setAttribute('kustomcp.result.is_partial', isPartial);
              span.setAttribute(
                'kustomcp.response.format',
                validatedConfig.responseFormat || 'json',
              );
              span.setAttribute(
                'kustomcp.write_allowed',
                validatedConfig.allowWriteOperations ?? false,
              );
              queryRowsHistogram.record(availableData.length, {
                tool: toolName,
              });

              // Create base response structure with all available data
              const baseResponse = {
                name: transformedResult.name,
                data: availableData,
                metadata: {
                  rowCount: 0, // Will be updated by response limiter
                  isPartial,
                  requestedLimit,
                  hasMoreResults: isPartial,
                  // Include query statistics in metadata only if enabled and present
                  ...(transformedResult.queryStatistics && {
                    queryStatistics: transformedResult.queryStatistics,
                  }),
                },
                // Zero rows is often a too-narrow filter, not missing data.
                message:
                  availableData.length === 0 ? EMPTY_RESULT_HINT : undefined,
              };
              if (availableData.length === 0) hintFired = 'empty_result';

              // Determine response format from config
              const responseFormat = validatedConfig.responseFormat || 'json';

              // Apply global response size limiting with dynamic row reduction
              const limitResult = limitResponseSize(baseResponse, {
                maxLength: globalCharLimit,
                minRows: minRows,
                format: responseFormat,
                formatOptions: {
                  maxColumnWidth: validatedConfig.markdownMaxCellLength,
                  showMetadata: true,
                },
              });

              span.setAttribute(
                'kustomcp.response.was_reduced',
                limitResult.wasReduced,
              );
              // What the agent actually got, after the limiter trimmed it.
              span.setAttribute(
                'kustomcp.result.delivered_row_count',
                limitResult.optimalRowCount,
              );
              span.setAttribute(
                'kustomcp.response.chars',
                limitResult.content.length,
              );
              span.setAttribute('kustomcp.response.max_chars', globalCharLimit);
              queryFacts = {
                limit: requestedLimit,
                partial: isPartial,
                rowCount: availableData.length,
              };
              queryReduced = limitResult.wasReduced;
              debugLog(`Using ${responseFormat} response format`);
              debugLog(
                `Global response limiting: ${
                  limitResult.wasReduced ? 'Applied' : 'Not needed'
                }`,
              );
              debugLog(
                `Optimal row count: ${limitResult.optimalRowCount} / ${limitResult.originalRowCount}`,
              );
              debugLog(
                `Final response size: ${limitResult.finalCharCount} / ${globalCharLimit} chars`,
              );

              return {
                content: [
                  {
                    type: 'text',
                    text: limitResult.content,
                  },
                ],
              };
            }

            case 'show-function': {
              const args = ShowFunctionSchema.parse(request.params.arguments);
              const result = await showFunction(
                await requireConnection(),
                args.functionName,
              );
              return {
                content: [
                  { type: 'text', text: JSON.stringify(result, null, 2) },
                ],
              };
            }

            case 'report-issue': {
              const args = ReportIssueSchema.parse(request.params.arguments);

              // Whitelisted, low-sensitivity diagnostics only. Never the
              // cluster URL, database, identity, query text, or results.
              const diagnostics = {
                'kusto-mcp': VERSION,
                node: process.version,
                os: `${process.platform}/${process.arch}`,
                'mcp client': clientInfo?.name
                  ? `${clientInfo.name} ${clientInfo.version ?? ''}`.trim()
                  : 'unknown',
                'kusto connected': connection ? 'yes' : 'no',
                'response format': validatedConfig.responseFormat ?? 'json',
                'write mode':
                  (validatedConfig.allowWriteOperations ?? true) ? 'on' : 'off',
              };

              const report = buildReportIssueUrl({
                title: args.title,
                body: args.body,
                labels: args.labels,
                diagnostics,
                includeDiagnostics: args.includeDiagnostics,
              });

              // Privacy-safe telemetry: counts/flags only, never the text.
              span.setAttribute(
                'kustomcp.report.body_len',
                (args.body ?? '').length,
              );
              span.setAttribute(
                'kustomcp.report.label_count',
                args.labels?.length ?? 0,
              );
              span.setAttribute(
                'kustomcp.report.url_truncated',
                report.bodyTruncated,
              );
              span.setAttribute(
                'kustomcp.report.diagnostics_included',
                report.diagnosticsIncluded,
              );

              const notes: string[] = [];
              if (report.bodyTruncated) {
                notes.push(
                  'Note: the body was truncated to fit GitHub’s URL length limit — you can paste any missing detail after opening the link.',
                );
              }
              if (
                args.includeDiagnostics !== false &&
                !report.diagnosticsIncluded
              ) {
                notes.push(
                  'Note: the environment footer was dropped to fit the URL length limit.',
                );
              }

              const text = [
                `[Open a pre-filled GitHub issue for kusto-mcp](${report.url})`,
                '',
                'Open this link in a browser where you are signed in to GitHub, review the pre-filled title and body, then click **Submit new issue**. Nothing is filed automatically — this server holds no GitHub token and creates nothing on your behalf.',
                ...(notes.length > 0 ? ['', ...notes] : []),
                '',
                'If the link is not clickable, copy this URL:',
                '```',
                report.url,
                '```',
              ].join('\n');

              return {
                content: [{ type: 'text', text }],
              };
            }

            default:
              throw new McpError(
                ErrorCode.MethodNotFound,
                `Unknown tool: ${request.params.name}`,
              );
          }
        })();

        span.setStatus({ code: SpanStatusCode.OK });
        // Response size (bytes of the serialized content).
        try {
          const bytes = Buffer.byteLength(
            JSON.stringify(result.content ?? ''),
            'utf8',
          );
          span.setAttribute('kustomcp.response.bytes', bytes);
          responseBytesHistogram.record(bytes, {
            tool: toolName,
            format: validatedConfig.responseFormat || 'json',
          });
        } catch {
          /* ignore sizing errors */
        }
        return result;
      } catch (error) {
        // A client cancel (notifications/cancelled, or the client going away)
        // is the client's choice, not a failure: no ERROR status and no error
        // count (#366). The response below is the same either way.
        if (error instanceof KustoQueryCancelledError) {
          status = 'cancelled';
        } else {
          status = 'error';
          recordSpanError(span, error);
          toolErrorsCounter.add(1, {
            tool: toolName,
            error_type:
              error instanceof Error ? errorTypeName(error) : 'unknown',
          });
        }

        // Format the error message
        let errorMessage: string;
        if (error instanceof McpError) {
          errorMessage = `MCP Error: ${error.message}`;
        } else if (isKustoMcpError(error)) {
          errorMessage = formatKustoMcpError(error);
        } else {
          errorMessage = `Error: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
        criticalLog(`Error handling tool call: ${errorMessage}`);

        // Nudge an agent stuck in a loop of failing queries (#313).
        if (finishQuery) {
          // Only failures the agent can fix by rewriting the query count.
          // Timeouts and client cancels neither count nor reset the streak:
          // a timeout already carries its own hint (#312), and the two hints
          // must never stack.
          const queryFailure = !(
            error instanceof McpError ||
            error instanceof KustoTimeoutError ||
            error instanceof KustoQueryCancelledError ||
            error instanceof KustoConnectionError ||
            error instanceof KustoAuthenticationError ||
            error instanceof KustoValidationError ||
            isNotQueryFault(error)
          );
          const failureCategory =
            getFailureCategory(error) ??
            (error instanceof KustoQueryCancelledError
              ? 'cancelled'
              : error instanceof KustoTimeoutError
                ? 'timeout'
                : 'other');
          span.setAttribute('kustomcp.query.failure_category', failureCategory);
          finishQuery({
            status,
            partial: queryFacts?.partial,
            failureCategory,
            countsAsQueryFailure: queryFailure,
          });
          finishQuery = undefined;
          if (
            queryFailure &&
            session.consecutiveQueryFailures >= QUERY_FAILURE_HINT_AFTER
          ) {
            errorMessage += `\n${QUERY_FAILURE_HINT}`;
            hintFired = 'failure_streak';
          }
        }

        return {
          content: [{ type: 'text', text: errorMessage }],
          isError: true,
        };
      } finally {
        if (finishQuery) {
          finishQuery({
            status,
            partial: queryFacts?.partial,
            reduced: queryReduced,
            rowCount: queryFacts?.rowCount,
          });
        }
        if (toolName === 'execute-query') {
          // Streak as it stands after this call, i.e. what the #313 hint read.
          span.setAttribute(
            'kustomcp.session.failure_streak',
            failureStreakBucket(session.consecutiveQueryFailures),
          );
          span.setAttribute('kustomcp.hint.fired', hintFired);
        }
        session.recordCall(toolName);
        span.setAttribute('kustomcp.tool.status', status);
        toolCallsCounter.add(1, {
          tool: toolName,
          status,
        });
        toolDurationHistogram.record(Date.now() - startedAt, {
          tool: toolName,
          status,
        });
        span.end();
      }
    });
  });

  // The startup auto-connect runs before the MCP handshake, so its span has
  // no client name (#379). Once the handshake completes, log the client with
  // how long after the auto-connect start it arrived; service.instance.id
  // joins it to that span. Telemetry only; never throws.
  const autoConnectStartedAt = Date.now();
  server.oninitialized = () => {
    try {
      const client = server.getClientVersion();
      const name = clientNameForTelemetry(client?.name);
      const version = clientVersionForTelemetry(client?.version, client?.name);
      emitLog(SeverityNumber.INFO, 'INFO', 'MCP client identified', {
        ...(name && { 'mcp.client.name': name }),
        ...(version && { 'mcp.client.version': version }),
        'kustomcp.handshake_gap_ms': Date.now() - autoConnectStartedAt,
      });
    } catch {
      /* telemetry only */
    }
  };

  // Trigger auto-connection asynchronously (fire-and-forget)
  // This allows the server to start immediately while attempting connection in the background
  autoConnectInFlight = tryAutoConnect()
    .catch(error => {
      // This catch is redundant since tryAutoConnect already handles errors,
      // but it's a safety net in case of unexpected issues
      criticalLog(
        `Unexpected error in auto-connection: ${error instanceof Error ? error.message : String(error)}`,
      );
    })
    .finally(() => {
      autoConnectInFlight = null;
    });

  return server;
}

function registerPromptHandlers(
  server: Server,
  promptManager: PromptManager,
): void {
  // Register the ListPrompts request handler
  server.setRequestHandler(ListPromptsRequestSchema, async request => {
    try {
      const cursor = request.params?.cursor;
      const result = promptManager.listPrompts(cursor);
      return result;
    } catch (error) {
      criticalLog(`Error listing prompts: ${error}`);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to list prompts: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  // Register the GetPrompt request handler
  server.setRequestHandler(GetPromptRequestSchema, async request => {
    try {
      const name = request.params.name;
      const arguments_ = request.params.arguments || {};
      const result = promptManager.getPrompt(name, arguments_);
      return result;
    } catch (error) {
      criticalLog(`Error getting prompt: ${error}`);

      if (error instanceof Error && error.message.includes('not found')) {
        throw new McpError(ErrorCode.InvalidParams, error.message);
      }

      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get prompt: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}
