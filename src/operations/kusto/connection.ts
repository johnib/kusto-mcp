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
import {
  SeverityNumber,
  carryErrorRecording,
  connectionAttemptsCounter,
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
  };
  if (e?.name === 'KustoAuthenticationError') return { category: 'auth' };
  if (e?.name === 'ThrottlingError')
    return { category: 'throttled', httpStatus: 429 };
  const status = e?.response?.status;
  if (typeof status === 'number') {
    if (status === 401 || status === 403)
      return { category: 'authz', httpStatus: status };
    if (status === 429) return { category: 'throttled', httpStatus: status };
    if (status >= 500) return { category: 'http_5xx', httpStatus: status };
    if (status >= 400) return { category: 'http_4xx', httpStatus: status };
  }
  switch (e?.code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return { category: 'dns_resolution' };
    case 'ECONNREFUSED':
      return { category: 'connection_refused' };
    case 'ETIMEDOUT':
    case 'ECONNABORTED':
      return { category: 'timeout' };
    case 'ERR_NETWORK':
      return { category: 'network' };
  }
  // Node TLS error CODES (e.g. CERT_HAS_EXPIRED, UNABLE_TO_VERIFY_LEAF_SIGNATURE,
  // DEPTH_ZERO_SELF_SIGNED_CERT) — the code, never the message.
  if (e?.code && /CERT|_SSL|_SIGN|TLS/i.test(e.code))
    return { category: 'tls' };
  return { category: 'unknown' };
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
      connectionAttemptsCounter.add(1, { source });
      // Bound the whole init (token acquisition + validation round-trip). Without
      // it, the client's HTTP default is 270s (see azure-kusto-data
      // QUERY_TIMEOUT_IN_MILLISECS), so a bad URL or hung auth stalls for minutes.
      const connectTimeout = this.config.connectionTimeout ?? 20000;
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
          await captureIdentity(clusterUrl, scope =>
            this.tokenCredential.getToken(scope),
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
          await tempClient.execute(database, 'print now()', props);
          return tempClient;
        };

        const tempClient = await Promise.race([connect(), deadline]);

        // Only set the instance variables after successful validation
        this.client = tempClient;
        this.database = database;

        debugLog('Connection initialized successfully');
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

        const classified = classifyConnectionFailure(error);
        // A fired deadline is definitively a timeout, regardless of the wrapped
        // error's shape.
        const category = timedOut ? 'timeout' : classified.category;
        span.setAttribute('kustomcp.connection.failure_category', category);
        if (classified.httpStatus !== undefined) {
          span.setAttribute('kustomcp.http.status_code', classified.httpStatus);
        }
        connectionFailuresCounter.add(1, {
          source,
          error_type: error instanceof Error ? error.name : 'unknown',
          failure_category: category,
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
        // Never record raw query text on exported spans; record only its length.
        span.setAttribute('kustomcp.query.length', query.length);

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
