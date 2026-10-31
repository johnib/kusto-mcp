import { randomUUID } from 'node:crypto';
import { TokenCredential } from '@azure/identity';
import { Span, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import {
  Client,
  ClientRequestProperties,
  KustoConnectionStringBuilder,
} from 'azure-kusto-data';
import { kustoTokenScope } from '../../auth/kusto-scope.js';
import {
  CachingTokenCredential,
  createTokenCredential,
} from '../../auth/token-credentials.js';
import {
  extractKustoErrorMessage,
  FailureCategory,
  KustoAuthenticationError,
  KustoConnectionError,
  KustoQueryCancelledError,
  KustoTimeoutError,
  markNotQueryFault,
  setFailureCategory,
} from '../../common/errors.js';
import { trackPendingCancel } from '../../common/shutdown.js';
import { criticalLog, debugLog } from '../../common/utils.js';
import {
  captureIdentity,
  getIdentityAttributes,
} from '../../common/identity.js';
import { markConnected } from '../../common/machine-id.js';
import {
  ConnectionFailureCategory,
  connectionFailureHint,
  ProbeResult,
  probeReachability,
} from '../../common/connection-hints.js';
import {
  SeverityNumber,
  carryErrorRecording,
  connectionAttemptsCounter,
  connectionDurationHistogram,
  connectionFailuresCounter,
  emitLog,
  queriesCounter,
  queryDurationHistogram,
  recordSpanError,
} from '../../common/telemetry.js';
import { KustoConfig } from '../../types/config.js';
import { KustoQueryResult } from '../../types/kusto-interfaces.js';

// Create a tracer for this module
const tracer = trace.getTracer('kusto-connection');

/** Kusto's maximum allowed `servertimeout` (1 hour). */
const MAX_SERVER_TIMEOUT_MS = 60 * 60 * 1000;
/** Extra HTTP wait beyond the query timeout, so a server timeout error arrives. */
const CLIENT_TIMEOUT_GRACE_MS = 30000;
/** HTTP bound for the best-effort `.cancel query` sent on client cancel. */
const CANCEL_COMMAND_TIMEOUT_MS = 10000;
/** Bound for the reachability probe run after an unclassified failure. */
const REACHABILITY_PROBE_TIMEOUT_MS = 3000;

/**
 * Kusto's structured server-timeout error, as returned by a live cluster:
 * code "RequestExecutionTimeout", @type KustoServiceTimeoutException.
 */
const SERVER_TIMEOUT_CODE = 'RequestExecutionTimeout';
const SERVER_TIMEOUT_TYPE =
  'Kusto.Data.Exceptions.KustoServiceTimeoutException';
/**
 * azure-kusto-data (7.2.0) reports v2 query errors that arrive in an HTTP 200
 * body as a plain Error built from each error's @message only, dropping
 * code/@type. This is that exact message for a server timeout.
 */
const SDK_SERVER_TIMEOUT_MESSAGE = 'Kusto request had errors. Query timed out';

/**
 * Classify an error into a low-cardinality outcome for query metrics. Timeouts
 * come from our own timer flag, axios's timeout code, or Kusto's structured
 * timeout error — never from a message that merely mentions a timeout.
 */
function classifyQueryOutcome(
  error: unknown,
  clientTimedOut: boolean,
): {
  outcome: 'timeout' | 'throttled' | 'cancelled_by_client' | 'error';
  timeoutKind?: 'client' | 'server';
} {
  if (error instanceof KustoQueryCancelledError)
    return { outcome: 'cancelled_by_client' };
  if (clientTimedOut || error instanceof KustoTimeoutError)
    return { outcome: 'timeout', timeoutKind: 'client' };
  const e = error as {
    code?: unknown;
    response?: { data?: { error?: { code?: unknown; '@type'?: unknown } } };
  };
  // axios's own HTTP timeout (setClientTimeout) is a client-side give-up.
  if (e?.code === 'ECONNABORTED')
    return { outcome: 'timeout', timeoutKind: 'client' };
  const kustoError = e?.response?.data?.error;
  if (
    kustoError?.code === SERVER_TIMEOUT_CODE ||
    kustoError?.['@type'] === SERVER_TIMEOUT_TYPE ||
    (error instanceof Error && error.message === SDK_SERVER_TIMEOUT_MESSAGE)
  )
    return { outcome: 'timeout', timeoutKind: 'server' };
  const m = extractKustoErrorMessage(error).toLowerCase();
  if (m.includes('throttl') || m.includes('e_too_many') || m.includes('429'))
    return { outcome: 'throttled' };
  return { outcome: 'error' };
}

/**
 * Map a connection failure to a bounded, non-identifying category (+ the HTTP
 * status when present). Reads only the error class name, the network `code`
 * (ECONNREFUSED / ENOTFOUND / TLS cert codes …) and the numeric HTTP status —
 * never the error message, which could echo a cluster/db name or identifier.
 * The returned category is a closed enum safe to use as a span attribute and a
 * metric label.
 */
function classifyConnectionFailure(error: unknown): {
  category: ConnectionFailureCategory;
  httpStatus?: number;
} {
  const e = error as {
    name?: string;
    code?: string;
    response?: { status?: number };
    cause?: { code?: string };
  };
  if (e?.name === 'KustoAuthenticationError') return { category: 'auth' };
  if (e?.name === 'ThrottlingError')
    return { category: 'throttled', httpStatus: 429 };
  // HTTP status is the most reliable signal for server-side failures. axios may
  // rewrite the top-level code (e.g. ERR_BAD_REQUEST/ERR_BAD_RESPONSE) while the
  // status still sits on error.response.
  const status = e?.response?.status;
  if (typeof status === 'number') {
    if (status === 401 || status === 403)
      return { category: 'authz', httpStatus: status };
    if (status === 429) return { category: 'throttled', httpStatus: status };
    if (status === 408) return { category: 'timeout', httpStatus: status };
    if (status >= 500) return { category: 'http_5xx', httpStatus: status };
    if (status >= 400) return { category: 'http_4xx', httpStatus: status };
  }
  // Network-level failures: axios frequently nests the original OS error under
  // `.cause`, so match the top-level code AND the cause's code.
  const codes = [e?.code, e?.cause?.code].filter(
    (c): c is string => typeof c === 'string',
  );
  for (const code of codes) {
    switch (code) {
      case 'ENOTFOUND':
      case 'EAI_AGAIN':
        return { category: 'dns_resolution' };
      case 'ECONNREFUSED':
        return { category: 'connection_refused' };
      case 'ETIMEDOUT':
      case 'ECONNABORTED':
        return { category: 'timeout' };
    }
    // Node TLS error CODES (e.g. CERT_HAS_EXPIRED,
    // UNABLE_TO_VERIFY_LEAF_SIGNATURE) — the code, never the message.
    if (/CERT|_SSL|_SIGN|TLS/i.test(code)) return { category: 'tls' };
  }
  // axios's generic network error, when no more specific code surfaced.
  if (codes.includes('ERR_NETWORK')) return { category: 'network' };
  return { category: 'unknown' };
}

// Query failures from these categories can't be fixed by rewriting the query,
// so they stay out of the error-loop hint streak (#313). HTTP 4xx (Kusto
// semantic errors) still count; query-limit failures arrive as HTTP 200
// partial failures, so a 5xx is a service/gateway fault. Timeouts and client
// cancels are kept out too (marked where they are rethrown below): a timeout
// carries its own recovery hint (#312), and schema advice is wrong after one.
const NOT_QUERY_FAULT_CATEGORIES: ReadonlySet<string> = new Set([
  'auth',
  'authz',
  'throttled',
  'http_5xx',
  'dns_resolution',
  'connection_refused',
  'tls',
  'network',
  'timeout',
]);

/**
 * Map a failed query to a bounded `kustomcp.query.failure_category` (+ the
 * HTTP status when the response carried one). Reads the outcome, the error
 * class, the HTTP status and the network code — never the message. Kusto
 * answers a KQL syntax/semantic error with HTTP 400.
 */
function classifyQueryFailure(
  error: unknown,
  outcome: ReturnType<typeof classifyQueryOutcome>['outcome'],
): { category: FailureCategory; httpStatus?: number } {
  const response = (
    error as {
      response?: { status?: unknown; data?: { error?: { code?: unknown } } };
    }
  )?.response;
  const httpStatus =
    typeof response?.status === 'number' ? response.status : undefined;
  const category = ((): FailureCategory => {
    if (outcome === 'cancelled_by_client') return 'cancelled';
    if (outcome === 'timeout') return 'timeout';
    if (error instanceof KustoConnectionError) return 'not_connected';
    // Not outcome === 'throttled': that one is matched in the message.
    switch (classifyConnectionFailure(error).category) {
      case 'auth':
      case 'authz':
        return 'auth_forbidden';
      case 'throttled':
        return 'throttled';
      case 'timeout':
        // Socket ETIMEDOUT / HTTP 408: not our query deadline (outcome stays
        // 'error', no timeout hint), so keep 'timeout' for outcome=timeout.
        return httpStatus === undefined ? 'network' : 'other';
      case 'http_5xx':
        return 'server_error';
      case 'dns_resolution':
      case 'connection_refused':
      case 'tls':
      case 'network':
        return 'network';
    }
    // A missing database is also a 400, but rewriting the KQL can't fix it.
    return httpStatus === 400 &&
      response?.data?.error?.code !== 'BadRequest_EntityNotFound'
      ? 'query_semantic'
      : 'other';
  })();
  return { category, httpStatus };
}

/**
 * Map a failure category (+ whether our deadline fired) to a coarse connection
 * outcome used as a metric label. Kept low-cardinality so it is cheap to slice.
 */
function connectionOutcome(
  category: ReturnType<typeof classifyConnectionFailure>['category'],
  timedOut: boolean,
):
  | 'timeout'
  | 'auth_error'
  | 'authz_denied'
  | 'throttled'
  | 'network_error'
  | 'error' {
  if (timedOut || category === 'timeout') return 'timeout';
  if (category === 'auth') return 'auth_error';
  if (category === 'authz') return 'authz_denied';
  if (category === 'throttled') return 'throttled';
  if (
    category === 'dns_resolution' ||
    category === 'connection_refused' ||
    category === 'tls' ||
    category === 'network'
  )
    return 'network_error';
  return 'error';
}

/**
 * Cloud class from the cluster host SUFFIX only. The org-specific subdomain is
 * dropped before emit, so the result is one of four fixed, non-identifying
 * values — never the cluster name.
 */
function classifyCloud(
  clusterUrl: string,
): 'public' | 'usgov' | 'china' | 'other' {
  let host: string;
  try {
    host = new URL(clusterUrl).hostname.toLowerCase();
  } catch {
    return 'other';
  }
  if (host.endsWith('.kusto.windows.net')) return 'public';
  if (host.endsWith('.kusto.usgovcloudapi.net')) return 'usgov';
  if (host.endsWith('.kusto.chinacloudapi.cn')) return 'china';
  return 'other';
}

/**
 * Kusto error codes we export as-is. Codes are fixed identifiers, but only
 * these leave the process; anything else is 'other'.
 */
const KUSTO_ERROR_CODES: ReadonlySet<string> = new Set([
  'BadRequest_EntityNotFound',
  'General_BadRequest',
  'BadRequest_SyntaxError',
  'BadRequest_SemanticError',
  'Forbidden',
  'Unauthorized',
  'LimitsExceeded',
  'RequestExecutionTimeout',
  'ServiceUnavailable',
  'TooManyRequests',
  'InternalServiceError',
]);

/** The response's Kusto `error.code`, bounded by KUSTO_ERROR_CODES. */
function kustoErrorCode(error: unknown): string | undefined {
  const code = (
    error as { response?: { data?: { error?: { code?: unknown } } } }
  )?.response?.data?.error?.code;
  if (typeof code !== 'string') return undefined;
  return KUSTO_ERROR_CODES.has(code) ? code : 'other';
}

/**
 * Token-step counters from the caching credential: inner fetches started
 * and requests served from the cache during this step, plus which credential
 * produced the token. Absent when the credential isn't the cache (tests).
 * Never throws.
 */
function recordTokenStats(
  span: Span,
  cache: Partial<CachingTokenCredential>,
  before: { fetches: number; hits: number } | undefined,
  gotToken: boolean,
): void {
  try {
    if (!cache.stats || !before) return;
    span.setAttribute(
      'kustomcp.auth.token_fetches',
      cache.stats.fetches - before.fetches,
    );
    span.setAttribute(
      'kustomcp.auth.token_cache_hits',
      cache.stats.hits - before.hits,
    );
    if (gotToken && cache.lastSource) {
      span.setAttribute('kustomcp.auth.credential_used', cache.lastSource);
    }
  } catch {
    /* telemetry only */
  }
}

/**
 * Coarse size bucket of a query, derived from its length only (the raw length
 * already ships; this is strictly coarser). Lets us tell a heavy query from a
 * systemic slowdown without any query text.
 */
function querySizeClass(length: number): 'xs' | 's' | 'm' | 'l' | 'xl' {
  if (length < 128) return 'xs';
  if (length < 512) return 's';
  if (length < 2048) return 'm';
  if (length < 8192) return 'l';
  return 'xl';
}

/**
 * Class for managing connections to Kusto clusters
 */
export class KustoConnection {
  private client: Client | null = null;
  private database: string | null = null;
  // Cluster + database once connected. Compared only, never exported or hashed.
  private target: string | undefined;
  private config: KustoConfig;
  private tokenCredential: TokenCredential;

  /**
   * Create a new KustoConnection
   *
   * @param config The Kusto configuration
   */
  constructor(config: KustoConfig) {
    this.config = config;
    // Credential subprocesses (`az`) are killed at the connect deadline, so a
    // hung one can't outlive the attempt that spawned it (#293).
    this.tokenCredential = createTokenCredential(
      config.authMethod,
      config.connectionTimeout ?? 20000,
    );
  }

  /**
   * Initialize the connection to the Kusto cluster
   *
   * @param clusterUrl The URL of the Kusto cluster
   * @param database The database to connect to
   * @param source Whether this is a manual (tool) or auto connection
   * @param inUse The connection the server is using now, if any
   * @returns A structured connection result
   */
  async initialize(
    clusterUrl: string,
    database: string,
    source: 'auto' | 'manual' = 'manual',
    inUse?: KustoConnection | null,
  ): Promise<{ success: boolean; cluster: string; database: string }> {
    return tracer.startActiveSpan('mcp.connection.init', async span => {
      span.setAttribute('kustomcp.connection.source', source);
      span.setAttribute('kustomcp.cloud', classifyCloud(clusterUrl));
      const proxyConfigured = !!(
        process.env.HTTPS_PROXY ||
        process.env.https_proxy ||
        process.env.HTTP_PROXY ||
        process.env.http_proxy
      );
      span.setAttribute('kustomcp.proxy_configured', proxyConfigured);
      // v2: metadata → one token fetch → query. token_ms and connect_ms mean
      // different things than in v1, so compare only within a pipeline.
      span.setAttribute('kustomcp.connection.pipeline', 'v2');
      connectionAttemptsCounter.add(1, { source });
      // Bound the whole init (token acquisition + validation round-trip). Without
      // it, the client's HTTP default is 270s (see azure-kusto-data
      // QUERY_TIMEOUT_IN_MILLISECS), so a bad URL or hung auth stalls for minutes.
      const connectTimeout = this.config.connectionTimeout ?? 20000;
      const startedAt = Date.now();
      let timedOut = false;
      let deadlineTimer: NodeJS.Timeout | undefined;
      // Which step is running, and the bounded token result, for the
      // user-facing hint on failure (#315).
      let step: 'metadata' | 'token' | 'query' = 'metadata';
      let stepStartedAt = startedAt;
      let tokenAttrs: Record<string, unknown> = {};
      // The validation client, closed on any failure (#290). `abandoned` stops
      // a connect that is still running after the deadline from opening one.
      let tempClient: Client | undefined;
      let abandoned = false;
      try {
        debugLog(
          `Initializing connection to ${clusterUrl}, database: ${database}`,
        );

        const deadline = new Promise<never>((_, reject) => {
          deadlineTimer = setTimeout(() => {
            timedOut = true;
            reject(
              new KustoConnectionError(
                `Connection timed out after ${connectTimeout}ms`,
              ),
            );
          }, connectTimeout);
          // Don't keep the event loop alive solely for this timer.
          deadlineTimer.unref?.();
        });

        // The connect critical section, raced against the deadline.
        const connect = async (): Promise<Client> => {
          // Cloud metadata first: it gives the exact scope the SDK will ask
          // for, and is cached in the SDK, so its own lookup later is free.
          const metadataStart = Date.now();
          const scope = await kustoTokenScope(clusterUrl);
          span.setAttribute(
            'kustomcp.connection.metadata_ms',
            Date.now() - metadataStart,
          );
          if (timedOut) {
            throw new KustoConnectionError('Connection attempt abandoned');
          }
          step = 'token';
          stepStartedAt = Date.now();

          // The one token fetch of this connect. The SDK requests the same
          // scope through the same caching credential, so its request is a
          // cache hit instead of a second `az` run. The token also gives the
          // anonymous cohort hashes (company/user); on failure, a bounded
          // classification of WHY (identity_state / auth.*). A capture that
          // settles after the deadline is ignored (#293).
          const tokenStart = stepStartedAt;
          let tokenError: unknown;
          let gotToken = false;
          const cache = this.tokenCredential as Partial<CachingTokenCredential>;
          const before = cache.stats ? { ...cache.stats } : undefined;
          const captured = await captureIdentity(
            scope,
            async s => {
              try {
                const token = await this.tokenCredential.getToken(s);
                gotToken = !!token?.token;
                return token;
              } catch (error) {
                tokenError = error;
                throw error;
              } finally {
                recordTokenStats(span, cache, before, gotToken);
              }
            },
            () => timedOut,
          );
          // The deadline already failed this attempt: stop here instead of
          // running a validation query nobody awaits.
          if (timedOut) {
            throw new KustoConnectionError('Connection attempt abandoned');
          }
          tokenAttrs = captured;
          span.setAttribute(
            'kustomcp.connection.token_ms',
            Date.now() - tokenStart,
          );
          for (const [k, v] of Object.entries(getIdentityAttributes())) {
            if (v !== undefined && v !== null) span.setAttribute(k, v);
          }
          // Fail now: the SDK would only walk the same credential again.
          if (!gotToken) {
            const failure = new KustoAuthenticationError(
              tokenError === undefined
                ? 'The credential returned no token'
                : extractKustoErrorMessage(tokenError),
            );
            if (tokenError !== undefined)
              carryErrorRecording(tokenError, failure);
            throw failure;
          }
          step = 'query';
          stepStartedAt = Date.now();

          // Both auth methods go through our caching, time-limited credential.
          // Don't use withAzLoginIdentity: it builds its own uncached
          // AzureCliCredential, which spawns `az` on every request (#296) with
          // no process timeout (#293).
          debugLog(
            `Using ${this.config.authMethod ?? 'default'} credential for connection`,
          );
          const connectionString =
            KustoConnectionStringBuilder.withTokenCredential(
              clusterUrl,
              this.tokenCredential,
            );

          if (abandoned) throw new Error('Connection attempt abandoned');
          // Create a temporary client for validation, don't set instance variables yet
          const client = new Client(connectionString);
          tempClient = client;

          // Bound the HTTP round-trip itself (library default is 270s).
          const props = new ClientRequestProperties();
          props.setClientTimeout(connectTimeout);

          // Test basic connectivity and authentication with a universal query.
          // This works with regular Kusto clusters and ADX Proxy endpoints.
          const connectStart = Date.now();
          await client.execute(database, 'print now()', props);
          span.setAttribute(
            'kustomcp.connection.connect_ms',
            Date.now() - connectStart,
          );
          return client;
        };

        const validated = await Promise.race([connect(), deadline]);

        // Only set the instance variables after successful validation
        this.client = validated;
        this.database = database;

        debugLog('Connection initialized successfully');
        // Record duration BEFORE markConnected so its one-time sync I/O (first
        // success only) isn't folded into the reported connection duration.
        const elapsedMs = Date.now() - startedAt;
        span.setAttribute('kustomcp.connection.outcome', 'success');
        span.setAttribute('kustomcp.connection.timed_out', false);
        span.setAttribute('kustomcp.connection.duration_ms', elapsedMs);
        // Onboarding funnel: true only on this install's first-ever success.
        span.setAttribute('kustomcp.connection.first_success', markConnected());
        // Compared with the connection in use; absent when there is none.
        this.target =
          `${clusterUrl.trim().replace(/\/+$/, '')}\n${database.trim().replace(/\/+$/, '')}`.toLowerCase();
        if (inUse?.target !== undefined) {
          span.setAttribute(
            'kustomcp.connection.target_changed',
            this.target !== inUse.target,
          );
        }
        connectionDurationHistogram.record(elapsedMs, {
          source,
          outcome: 'success',
        });
        span.setStatus({ code: SpanStatusCode.OK });
        emitLog(SeverityNumber.INFO, 'INFO', 'Connection established', {
          'kustomcp.connection.source': source,
        });

        return {
          success: true,
          cluster: clusterUrl,
          database: database,
        };
      } catch (error) {
        abandoned = true;
        try {
          tempClient?.close();
        } catch {
          /* best effort */
        }
        // Assigned inside connect(), which TS's narrowing can't see.
        const failedStep = step as 'metadata' | 'token' | 'query';
        const errorMessage = extractKustoErrorMessage(error);

        criticalLog(`Failed to initialize connection: ${errorMessage}`);

        // Debug-only (stderr, never telemetry): the raw fields the classifier
        // keys on, so the failure_category enum can be validated against real
        // azure-kusto-data/axios error shapes post-deploy.
        const rawErr = error as {
          name?: string;
          code?: string;
          cause?: { code?: string };
          response?: { status?: number };
        };
        debugLog(
          `connection failure shape: name=${rawErr?.name} code=${rawErr?.code} cause=${rawErr?.cause?.code} status=${rawErr?.response?.status}`,
        );

        const classified = classifyConnectionFailure(error);
        // A fired deadline is definitively a timeout, regardless of the wrapped
        // error's shape.
        const category = timedOut ? 'timeout' : classified.category;
        const outcome = connectionOutcome(category, timedOut);
        span.setAttribute('kustomcp.connection.failure_category', category);
        span.setAttribute('kustomcp.connection.outcome', outcome);
        span.setAttribute('kustomcp.connection.timed_out', timedOut);
        span.setAttribute(
          'kustomcp.connection.duration_ms',
          Date.now() - startedAt,
        );
        if (classified.httpStatus !== undefined) {
          span.setAttribute('kustomcp.http.status_code', classified.httpStatus);
        }
        // Which step failed (or was running when the deadline fired), and
        // how long it ran: tells a slow token from a slow cluster.
        span.setAttribute('kustomcp.connection.failed_step', failedStep);
        span.setAttribute(
          'kustomcp.connection.failed_step_ms',
          Date.now() - stepStartedAt,
        );
        const kustoCode = kustoErrorCode(error);
        if (kustoCode !== undefined) {
          span.setAttribute('kustomcp.connection.kusto_error_code', kustoCode);
        }
        connectionFailuresCounter.add(1, {
          source,
          error_type: error instanceof Error ? error.name : 'unknown',
          failure_category: category,
        });
        connectionDurationHistogram.record(Date.now() - startedAt, {
          source,
          outcome,
        });
        recordSpanError(span, error);
        emitLog(SeverityNumber.ERROR, 'ERROR', 'Connection failed', {
          'kustomcp.connection.source': source,
          'kustomcp.connection.failure_category': category,
          'kustomcp.error.type':
            error instanceof Error ? error.name : 'unknown',
        });

        // The SDK drops the socket error code on its cloud-metadata lookup,
        // so probe the host once to tell DNS / refused apart. Only within
        // what is left of the connect deadline, so initialize() stays bounded
        // by connectionTimeout. The result goes on the span either way; a
        // direct probe means nothing behind a proxy, so there it doesn't
        // change the hint (proxy_configured on the span tells them apart).
        let hintCategory = category;
        const probeBudget = Math.min(
          REACHABILITY_PROBE_TIMEOUT_MS,
          connectTimeout - (Date.now() - startedAt),
        );
        if (category === 'unknown' && probeBudget > 0) {
          let probeResult: ProbeResult | undefined;
          const probed = await probeReachability(
            clusterUrl,
            probeBudget,
            r => (probeResult = r),
          );
          if (probeResult !== undefined) {
            span.setAttribute('kustomcp.connection.probe_result', probeResult);
          }
          if (!proxyConfigured) hintCategory = probed ?? category;
        }
        const hint = connectionFailureHint({
          category: hintCategory,
          httpStatus: classified.httpStatus,
          timedOutStep: timedOut
            ? failedStep === 'token'
              ? 'token'
              : 'cluster'
            : undefined,
          tokenFailed: tokenAttrs['kustomcp.auth.token_acquired'] === false,
          authStage: tokenAttrs['kustomcp.auth.failure_stage'] as
            string | undefined,
          aadsts: tokenAttrs['kustomcp.auth.aadsts'] as string | undefined,
          authMethod: this.config.authMethod,
          source,
          clusterUrl,
          database,
          timeoutMs: connectTimeout,
        });
        // Our own deadline error already carries the "Connection error: "
        // prefix; don't repeat it.
        const base =
          error instanceof KustoConnectionError
            ? errorMessage.replace(/^Connection error: /, '')
            : errorMessage;
        const wrapped = new KustoConnectionError(`${base}\n${hint}`);
        carryErrorRecording(error, wrapped);
        throw wrapped;
      } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        span.end();
      }
    });
  }

  /**
   * Execute a query on the Kusto cluster
   *
   * @param database The database to execute the query on
   * @param query The query to execute
   * @param signal Aborts when the MCP client cancels the request; the query is
   *   then cancelled on the cluster (best effort)
   * @returns The result of the query
   */
  async executeQuery(
    database: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<KustoQueryResult> {
    return tracer.startActiveSpan(
      'kusto.query',
      { kind: SpanKind.CLIENT },
      async span => {
        const operation = query.trimStart().startsWith('.')
          ? 'command'
          : 'query';
        const startedAt = Date.now();
        span.setAttribute('kustomcp.operation', operation);
        // Never record raw query text on exported spans; record only its length
        // and a coarse size bucket.
        span.setAttribute('kustomcp.query.length', query.length);
        span.setAttribute(
          'kustomcp.query.size_class',
          querySizeClass(query.length),
        );
        // Stamp the same anonymous cohort hashes carried on the parent tool span,
        // so query outcomes/timeouts are sliceable by user/company without a
        // trace-join. No new information type — these already exist on the trace.
        for (const [k, v] of Object.entries(getIdentityAttributes())) {
          if (v !== undefined && v !== null) span.setAttribute(k, v);
        }

        // Tracks whether OUR client-side timeout fired (vs a server timeout),
        // without reading the error message.
        let clientTimedOut = false;

        try {
          if (!this.client) {
            throw new KustoConnectionError('Connection not initialized');
          }

          // Cancelled before we got here: don't start a query only to race
          // a `.cancel query` against it.
          if (signal?.aborted) {
            throw new KustoQueryCancelledError('Query cancelled by the client');
          }

          debugLog(`Executing query on database ${database}: ${query}`);

          // Set timeout from config
          const timeout = this.config.queryTimeout || 120000;
          span.setAttribute('kustomcp.query.timeout_ms', timeout);

          // Tell the server to stop at the same deadline (Kusto caps
          // servertimeout at 1h); without it the server applies its own ~4 min
          // default and keeps running after our timer fires. The HTTP layer
          // waits a little longer so the server's timeout error can arrive.
          const props = new ClientRequestProperties();
          props.setTimeout(Math.min(timeout, MAX_SERVER_TIMEOUT_MS));
          props.setClientTimeout(timeout + CLIENT_TIMEOUT_GRACE_MS);
          // Our own id, so the query can be cancelled by `.cancel query`.
          const clientRequestId = `KustoMcp.execute;${randomUUID()}`;
          props.clientRequestId = clientRequestId;

          // Execute the query with timeout, ensuring timeout handle is always cleared
          let timeoutHandle: NodeJS.Timeout;
          const client = this.client;
          const queryPromise = client.execute(database, query, props);

          const rawResult = await new Promise((resolve, reject) => {
            // The client cancelled the tool call: stop waiting and ask the
            // cluster to cancel the query. Fire-and-forget; never throws.
            const onAbort = () => {
              cleanup();
              reject(
                new KustoQueryCancelledError('Query cancelled by the client'),
              );
              try {
                const cancelProps = new ClientRequestProperties();
                cancelProps.setClientTimeout(CANCEL_COMMAND_TIMEOUT_MS);
                // Tracked so a shutdown can let it reach the cluster (#333).
                trackPendingCancel(
                  client
                    .execute(
                      database,
                      `.cancel query "${clientRequestId}"`,
                      cancelProps,
                    )
                    .catch(err =>
                      debugLog(
                        `Best-effort .cancel query failed: ${extractKustoErrorMessage(err)}`,
                      ),
                    ),
                );
              } catch {
                /* best effort */
              }
            };
            const cleanup = () => {
              clearTimeout(timeoutHandle);
              signal?.removeEventListener('abort', onAbort);
            };

            timeoutHandle = setTimeout(() => {
              cleanup();
              clientTimedOut = true;
              reject(
                new KustoTimeoutError(`Query timed out after ${timeout}ms`),
              );
            }, timeout);

            if (signal?.aborted) onAbort();
            else signal?.addEventListener('abort', onAbort, { once: true });

            queryPromise
              .then(result => {
                cleanup();
                resolve(result);
              })
              .catch(err => {
                cleanup();
                reject(err);
              });
          });

          debugLog(`Raw Kusto Response: ${JSON.stringify(rawResult, null, 2)}`);

          // Convert the result to a JSON-friendly format
          // Cast the result to KustoQueryResult type
          const formattedResult = rawResult as KustoQueryResult;

          debugLog('Query executed successfully');
          span.setAttribute('kustomcp.outcome', 'success');
          span.setStatus({ code: SpanStatusCode.OK });
          queriesCounter.add(1, {
            operation,
            outcome: 'success',
          });
          queryDurationHistogram.record(Date.now() - startedAt, {
            operation,
            outcome: 'success',
          });

          return formattedResult;
        } catch (error) {
          const errorMessage = extractKustoErrorMessage(error);
          const { outcome, timeoutKind } = classifyQueryOutcome(
            error,
            clientTimedOut,
          );

          criticalLog(`Failed to execute query: ${errorMessage}`);

          span.setAttribute('kustomcp.outcome', outcome);
          const failure = classifyQueryFailure(error, outcome);
          span.setAttribute(
            'kustomcp.query.failure_category',
            failure.category,
          );
          if (failure.httpStatus !== undefined) {
            span.setAttribute('kustomcp.http.status_code', failure.httpStatus);
          }
          // Carried through the re-wrapping layers to the execute-query span.
          setFailureCategory(error, failure.category);
          if (timeoutKind) {
            // Our wrapper fired (raise queryTimeout / heavy query) vs the server
            // reporting its own timeout (cluster-side pressure).
            span.setAttribute('kustomcp.query.timeout_kind', timeoutKind);
          }
          // A server or HTTP (ECONNABORTED) timeout surfaces as
          // KustoTimeoutError too, so users and error.type see a timeout
          // rather than a generic query error.
          const serverTimeout =
            outcome === 'timeout' && !(error instanceof KustoTimeoutError)
              ? new KustoTimeoutError(errorMessage)
              : undefined;
          if (serverTimeout) setFailureCategory(serverTimeout, 'timeout');
          // A client cancel is not a failure (#366): it keeps its outcome but
          // gets no ERROR status or error.type.
          if (outcome !== 'cancelled_by_client') {
            recordSpanError(span, serverTimeout ?? error);
          }
          queriesCounter.add(1, {
            operation,
            outcome,
          });
          queryDurationHistogram.record(Date.now() - startedAt, {
            operation,
            outcome,
          });

          // Our own timeout / client cancel keep their type so callers
          // report them as such. Neither is a fault in the query text, so
          // mark them before rethrowing to keep them out of the error-loop
          // streak even if a caller re-wraps them.
          if (
            error instanceof KustoTimeoutError ||
            error instanceof KustoQueryCancelledError
          ) {
            markNotQueryFault(error);
            throw error;
          }
          if (serverTimeout) {
            markNotQueryFault(serverTimeout);
            throw serverTimeout;
          }

          // Don't wrap as KustoQueryError here since queries.ts will handle it
          // Just rethrow with the detailed error message
          const customError = new Error(errorMessage);
          carryErrorRecording(error, customError);
          setFailureCategory(customError, failure.category);
          if (
            error instanceof KustoConnectionError ||
            // Not outcome === 'throttled': that one is matched in the message.
            failure.category === 'throttled' ||
            // A 400 that isn't a KQL error (e.g. a missing database).
            (failure.httpStatus === 400 &&
              failure.category !== 'query_semantic') ||
            NOT_QUERY_FAULT_CATEGORIES.has(
              classifyConnectionFailure(error).category,
            )
          ) {
            markNotQueryFault(customError);
          }
          throw customError;
        } finally {
          span.end();
        }
      },
    );
  }

  /**
   * Get the current database
   *
   * @returns The current database
   */
  getDatabase(): string {
    if (!this.database) {
      throw new KustoConnectionError('Connection not initialized');
    }

    return this.database;
  }

  /**
   * Release the client (cancels its in-flight requests). Only for a
   * connection nothing else uses. Never throws.
   */
  close(): void {
    try {
      this.client?.close();
    } catch {
      /* best effort */
    }
    this.client = null;
    this.database = null;
  }

  /**
   * Check if the connection is initialized
   *
   * @returns True if the connection is initialized, false otherwise
   */
  isInitialized(): boolean {
    return this.client !== null && this.database !== null;
  }
}
