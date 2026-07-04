import { TokenCredential } from '@azure/identity';
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import {
  Client,
  ClientRequestProperties,
  KustoConnectionStringBuilder,
} from 'azure-kusto-data';
import { createTokenCredential } from '../../auth/token-credentials.js';
import {
  extractKustoErrorMessage,
  KustoConnectionError,
  KustoQueryError,
} from '../../common/errors.js';
import { criticalLog, debugLog } from '../../common/utils.js';
import {
  captureIdentity,
  getIdentityAttributes,
} from '../../common/identity.js';
import { markConnected } from '../../common/machine-id.js';
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

/** Classify an error into a low-cardinality outcome for query metrics. */
function classifyQueryOutcome(
  message: string,
): 'timeout' | 'throttled' | 'error' {
  const m = message.toLowerCase();
  if (m.includes('timed out') || m.includes('timeout')) return 'timeout';
  if (m.includes('throttl') || m.includes('e_too_many') || m.includes('429'))
    return 'throttled';
  return 'error';
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
  category:
    | 'dns_resolution'
    | 'connection_refused'
    | 'tls'
    | 'timeout'
    | 'network'
    | 'http_4xx'
    | 'http_5xx'
    | 'authz'
    | 'auth'
    | 'throttled'
    | 'unknown';
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
  private config: KustoConfig;
  private tokenCredential: TokenCredential;

  /**
   * Create a new KustoConnection
   *
   * @param config The Kusto configuration
   */
  constructor(config: KustoConfig) {
    this.config = config;
    this.tokenCredential = createTokenCredential(config.authMethod);
  }

  /**
   * Initialize the connection to the Kusto cluster
   *
   * @param clusterUrl The URL of the Kusto cluster
   * @param database The database to connect to
   * @param source Whether this is a manual (tool) or auto connection
   * @returns A structured connection result
   */
  async initialize(
    clusterUrl: string,
    database: string,
    source: 'auto' | 'manual' = 'manual',
  ): Promise<{ success: boolean; cluster: string; database: string }> {
    return tracer.startActiveSpan('mcp.connection.init', async span => {
      span.setAttribute('kustomcp.connection.source', source);
      span.setAttribute('kustomcp.cloud', classifyCloud(clusterUrl));
      span.setAttribute(
        'kustomcp.proxy_configured',
        !!(
          process.env.HTTPS_PROXY ||
          process.env.https_proxy ||
          process.env.HTTP_PROXY ||
          process.env.http_proxy
        ),
      );
      connectionAttemptsCounter.add(1, { source });
      // Bound the whole init (token acquisition + validation round-trip). Without
      // it, the client's HTTP default is 270s (see azure-kusto-data
      // QUERY_TIMEOUT_IN_MILLISECS), so a bad URL or hung auth stalls for minutes.
      const connectTimeout = this.config.connectionTimeout ?? 20000;
      const startedAt = Date.now();
      let timedOut = false;
      let deadlineTimer: NodeJS.Timeout | undefined;
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
          // Capture anonymous cohort hashes (company/user) from the access token.
          // Best-effort; never throws. Done before validation so an authenticated
          // user that fails to connect is still counted. On failure this also
          // records a bounded classification of WHY (identity_state / auth.*).
          const tokenStart = Date.now();
          await captureIdentity(clusterUrl, scope =>
            this.tokenCredential.getToken(scope),
          );
          span.setAttribute(
            'kustomcp.connection.token_ms',
            Date.now() - tokenStart,
          );
          for (const [k, v] of Object.entries(getIdentityAttributes())) {
            if (v !== undefined && v !== null) span.setAttribute(k, v);
          }

          // Create a connection string with the configured authentication method
          let connectionString;

          if (this.config.authMethod === 'azure-cli') {
            debugLog('Using Azure CLI authentication for connection');
            connectionString =
              KustoConnectionStringBuilder.withAzLoginIdentity(clusterUrl);
          } else {
            debugLog(
              'Using Azure Identity (DefaultAzureCredential) for connection',
            );
            connectionString = KustoConnectionStringBuilder.withTokenCredential(
              clusterUrl,
              this.tokenCredential,
            );
          }

          // Create a temporary client for validation, don't set instance variables yet
          const tempClient = new Client(connectionString);

          // Bound the HTTP round-trip itself (library default is 270s).
          const props = new ClientRequestProperties();
          props.setClientTimeout(connectTimeout);

          // Test basic connectivity and authentication with a universal query.
          // This works with regular Kusto clusters and ADX Proxy endpoints.
          const connectStart = Date.now();
          await tempClient.execute(database, 'print now()', props);
          span.setAttribute(
            'kustomcp.connection.connect_ms',
            Date.now() - connectStart,
          );
          return tempClient;
        };

        const tempClient = await Promise.race([connect(), deadline]);

        // Only set the instance variables after successful validation
        this.client = tempClient;
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

        const wrapped = new KustoConnectionError(errorMessage);
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
   * @returns The result of the query
   */
  async executeQuery(database: string, query: string): Promise<any> {
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

          debugLog(`Executing query on database ${database}: ${query}`);

          // Set timeout from config
          const timeout = this.config.queryTimeout || 60000;
          span.setAttribute('kustomcp.query.timeout_ms', timeout);

          // Execute the query with timeout, ensuring timeout handle is always cleared
          let timeoutHandle: NodeJS.Timeout;
          const queryPromise = this.client.execute(database, query);

          const rawResult = await new Promise((resolve, reject) => {
            timeoutHandle = setTimeout(() => {
              clientTimedOut = true;
              reject(new KustoQueryError(`Query timed out after ${timeout}ms`));
            }, timeout);

            queryPromise
              .then(result => {
                clearTimeout(timeoutHandle);
                resolve(result);
              })
              .catch(err => {
                clearTimeout(timeoutHandle);
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
          const outcome = classifyQueryOutcome(errorMessage);

          criticalLog(`Failed to execute query: ${errorMessage}`);

          span.setAttribute('kustomcp.outcome', outcome);
          if (outcome === 'timeout') {
            // Our wrapper fired (raise queryTimeout / heavy query) vs the server
            // reporting its own timeout (cluster-side pressure).
            span.setAttribute(
              'kustomcp.query.timeout_kind',
              clientTimedOut ? 'client' : 'server',
            );
          }
          recordSpanError(span, error);
          queriesCounter.add(1, {
            operation,
            outcome,
          });
          queryDurationHistogram.record(Date.now() - startedAt, {
            operation,
            outcome,
          });

          // Don't wrap as KustoQueryError here since queries.ts will handle it
          // Just rethrow with the detailed error message
          const customError = new Error(errorMessage);
          carryErrorRecording(error, customError);
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
   * Check if the connection is initialized
   *
   * @returns True if the connection is initialized, false otherwise
   */
  isInitialized(): boolean {
    return this.client !== null && this.database !== null;
  }
}
