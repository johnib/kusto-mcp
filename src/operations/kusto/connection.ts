import { TokenCredential } from '@azure/identity';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { Client, KustoConnectionStringBuilder } from 'azure-kusto-data';
import { createTokenCredential } from '../../auth/token-credentials.js';
import { KustoConnectionError, KustoQueryError } from '../../common/errors.js';
import { criticalLog, debugLog } from '../../common/utils.js';
import { KustoConfig } from '../../types/config.js';
import { KustoQueryResult } from '../../types/kusto-interfaces.js';

// Create a tracer for this module
const tracer = trace.getTracer('kusto-connection');

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
   * @returns A structured connection result
   */
  async initialize(
    clusterUrl: string,
    database: string,
  ): Promise<{ success: boolean; cluster: string; database: string }> {
    return tracer.startActiveSpan('initialize', async span => {
      try {
        span.setAttribute('clusterUrl', clusterUrl);
        span.setAttribute('database', database);

        debugLog(
          `Initializing connection to ${clusterUrl}, database: ${database}`,
        );

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

        return {
          success: true,
          cluster: clusterUrl,
          database: database,
        };
      } catch (error) {
        let errorMessage =
          error instanceof Error ? error.message : String(error);

        // Extract detailed error message from Kusto response if available
        if (error && typeof error === 'object' && 'response' in error) {
          const response = (error as any).response;
          if (response?.data?.error?.['@message']) {
            errorMessage = response.data.error['@message'];
          } else if (response?.data?.error?.message) {
            errorMessage = response.data.error.message;
          }
        }

        criticalLog(`Failed to initialize connection: ${errorMessage}`);

        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: errorMessage,
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
    return tracer.startActiveSpan('executeQuery', async span => {
      try {
        span.setAttribute('database', database);
        span.setAttribute('query', query);

        if (!this.client) {
          throw new KustoConnectionError('Connection not initialized');
        }

        debugLog(`Executing query on database ${database}: ${query}`);

        // Set timeout from config
        const timeout = this.config.queryTimeout || 60000;

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
        span.setStatus({ code: SpanStatusCode.OK });

        return formattedResult;
      } catch (error) {
        let errorMessage =
          error instanceof Error ? error.message : String(error);

        // Extract detailed error message from Kusto response if available
        if (error && typeof error === 'object' && 'response' in error) {
          const response = (error as any).response;
          if (response?.data?.error?.['@message']) {
            errorMessage = response.data.error['@message'];
          } else if (response?.data?.error?.message) {
            errorMessage = response.data.error.message;
          }
        }

        criticalLog(`Failed to execute query: ${errorMessage}`);

        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: errorMessage,
        });

        // Don't wrap as KustoQueryError here since queries.ts will handle it
        // Just rethrow with the detailed error message
        const customError = new Error(errorMessage);
        throw customError;
      } finally {
        span.end();
      }
    });
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
