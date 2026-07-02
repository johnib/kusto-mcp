import { TokenCredential } from '@azure/identity';
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { Client, KustoConnectionStringBuilder } from 'azure-kusto-data';
import { createTokenCredential } from '../../auth/token-credentials.js';
import {
  extractKustoErrorMessage,
  KustoConnectionError,
  KustoQueryError,
} from '../../common/errors.js';
import { criticalLog, debugLog } from '../../common/utils.js';
import {
  captureIdentity,
  getMetricIdentityLabels,
} from '../../common/identity.js';
import {
  SeverityNumber,
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
      connectionAttemptsCounter.add(1, { source });
      try {
        debugLog(
          `Initializing connection to ${clusterUrl}, database: ${database}`,
        );

        // Capture identity BEFORE the validation query so users who authenticate
        // but fail to connect (wrong cluster/db, RBAC denied) are still attributed.
        // Best-effort; never throws.
        const identity = await captureIdentity(clusterUrl, database, scope =>
          this.tokenCredential.getToken(scope),
        );
        for (const [k, v] of Object.entries(identity)) {
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

        // Test basic connectivity and authentication with a universal query
        // This works with regular Kusto clusters and ADX Proxy endpoints
        await tempClient.execute(database, 'print now()');

        // Only set the instance variables after successful validation
        this.client = tempClient;
        this.database = database;

        debugLog('Connection initialized successfully');
        span.setStatus({ code: SpanStatusCode.OK });
        emitLog(SeverityNumber.INFO, 'INFO', 'Connection established', {
          'kustomcp.connection.source': source,
          ...getMetricIdentityLabels(),
        });

        return {
          success: true,
          cluster: clusterUrl,
          database: database,
        };
      } catch (error) {
        const errorMessage = extractKustoErrorMessage(error);

        criticalLog(`Failed to initialize connection: ${errorMessage}`);

        connectionFailuresCounter.add(1, {
          error_type: error instanceof Error ? error.name : 'unknown',
        });
        recordSpanError(span, error, errorMessage);
        emitLog(SeverityNumber.ERROR, 'ERROR', 'Connection failed', {
          'kustomcp.error.type':
            error instanceof Error ? error.name : 'unknown',
          ...getMetricIdentityLabels(),
        });

        throw new KustoConnectionError(errorMessage);
      } finally {
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
        span.setAttribute('kusto.database', database);
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
            ...getMetricIdentityLabels(),
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
          recordSpanError(span, error, errorMessage);
          queriesCounter.add(1, {
            operation,
            outcome,
            ...getMetricIdentityLabels(),
          });
          queryDurationHistogram.record(Date.now() - startedAt, {
            operation,
            outcome,
          });

          // Don't wrap as KustoQueryError here since queries.ts will handle it
          // Just rethrow with the detailed error message
          const customError = new Error(errorMessage);
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
