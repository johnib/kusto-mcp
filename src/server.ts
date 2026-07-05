import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { formatKustoMcpError, isKustoMcpError } from './common/errors.js';
import { criticalLog, debugLog } from './common/utils.js';
import { getIdentityAttributes } from './common/identity.js';
import {
  SeverityNumber,
  emitLog,
  recordSpanError,
  responseBytesHistogram,
  queryRowsHistogram,
  toolCallsCounter,
  toolDurationHistogram,
  toolErrorsCounter,
  toolNotInitializedCounter,
} from './common/telemetry.js';
import { appendRowLimit, assertQueryAllowed } from './common/kql-safety.js';
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
  query: z.string().describe('The query to execute'),
  limit: z
    .number()
    .optional()
    .default(20)
    .describe('Maximum number of rows to return (default: 20)'),
});

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

/**
 * Create a Kusto MCP server
 *
 * @param config The Kusto configuration
 * @returns A configured MCP server instance
 */
const serverTracer = trace.getTracer('kusto-mcp-server');

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

  // Initialize the prompt manager
  const promptManager = validatedConfig.enablePrompts
    ? new PromptManager()
    : null;

  // Auto-connection function
  async function tryAutoConnect(): Promise<void> {
    // Only attempt auto-connection if both cluster URL and database are configured
    if (!validatedConfig.clusterUrl || !validatedConfig.defaultDatabase) {
      debugLog(
        'Auto-connection skipped: missing cluster URL or database configuration',
      );
      return;
    }

    try {
      debugLog(
        `Attempting auto-connection to ${validatedConfig.clusterUrl} -> ${validatedConfig.defaultDatabase}`,
      );

      // Create a new connection
      const autoConnection = new KustoConnection(validatedConfig);

      // Initialize the connection
      const result = await autoConnection.initialize(
        validatedConfig.clusterUrl,
        validatedConfig.defaultDatabase,
        'auto',
      );

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
      // Don't throw - just log and continue with manual connection mode
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
            'Runs KQL queries and returns results. By default, limits results to 20 rows to prevent context overflow. Use the "limit" parameter to specify a different maximum. If results are marked as partial, consider revising your query to use aggregations, filters, or summarizations.',
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

  // Register the ListPrompts request handler
  server.setRequestHandler(ListPromptsRequestSchema, async request => {
    if (!validatedConfig.enablePrompts || !promptManager) {
      throw new McpError(ErrorCode.MethodNotFound, 'Prompts are disabled');
    }

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
    if (!validatedConfig.enablePrompts || !promptManager) {
      throw new McpError(ErrorCode.MethodNotFound, 'Prompts are disabled');
    }

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

  // Register the CallTool request handler
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const toolName = request.params.name;
    return serverTracer.startActiveSpan(`mcp.tool/${toolName}`, async span => {
      const startedAt = Date.now();
      let status = 'ok';

      span.setAttribute('kustomcp.tool.name', toolName);
      // MCP client (host app) identity — a first-order "who uses this" signal.
      const clientInfo = server.getClientVersion();
      if (clientInfo?.name)
        span.setAttribute('mcp.client.name', clientInfo.name);
      if (clientInfo?.version)
        span.setAttribute('mcp.client.version', clientInfo.version);
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
      const requireConnection = (): KustoConnection => {
        if (!connection) {
          toolNotInitializedCounter.add(1, { tool: toolName });
          throw new McpError(
            ErrorCode.InvalidRequest,
            'Connection not initialized. Please call initialize-connection first.',
          );
        }
        return connection;
      };

      try {
        const result = await (async () => {
          if (!request.params.arguments) {
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

              // Create a new connection each time initialize-connection is
              // called; this overrides any existing connection.
              connection = new KustoConnection(validatedConfig);

              const result = await connection.initialize(
                args.cluster_url,
                args.database,
                'manual',
              );
              return {
                content: [
                  { type: 'text', text: JSON.stringify(result, null, 2) },
                ],
              };
            }

            case 'show-tables': {
              ShowTablesSchema.parse(request.params.arguments);
              const result = await showTables(requireConnection());
              return {
                content: [
                  { type: 'text', text: JSON.stringify(result, null, 2) },
                ],
              };
            }

            case 'show-table': {
              const args = ShowTableSchema.parse(request.params.arguments);
              const result = await showTable(
                requireConnection(),
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
              const result = await showFunctions(requireConnection());
              return {
                content: [
                  { type: 'text', text: JSON.stringify(result, null, 2) },
                ],
              };
            }

            case 'execute-query': {
              const args = ExecuteQuerySchema.parse(request.params.arguments);
              const conn = requireConnection();

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

              // Get user-requested limit and global response limit
              const requestedLimit = args.limit || 20;
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
              const rawResult = await executeQuery(conn, modifiedQuery);

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
                'kustomcp.query.requested_limit',
                requestedLimit,
              );
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
                message: undefined, // Will be set by response limiter if needed
              };

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
                requireConnection(),
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
        status = 'error';
        recordSpanError(span, error);
        toolErrorsCounter.add(1, {
          tool: toolName,
          error_type: error instanceof Error ? error.name : 'unknown',
        });

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

        return {
          content: [{ type: 'text', text: errorMessage }],
          isError: true,
        };
      } finally {
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

  // Trigger auto-connection asynchronously (fire-and-forget)
  // This allows the server to start immediately while attempting connection in the background
  tryAutoConnect().catch(error => {
    // This catch is redundant since tryAutoConnect already handles errors,
    // but it's a safety net in case of unexpected issues
    criticalLog(
      `Unexpected error in auto-connection: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  return server;
}
