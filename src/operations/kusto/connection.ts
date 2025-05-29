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

        // Create a connection string with Azure CLI authentication
        // This will use the token from Azure CLI for authentication
        const connectionString =
          KustoConnectionStringBuilder.withAzLoginIdentity(clusterUrl);

        this.client = new Client(connectionString);
        this.database = database;

        // Test the connection with cluster-level query first
        await this.executeQuery(database, '.show version');

        // Validate that the database exists by checking the databases list
        const databaseCheckResult = await this.executeQuery(
          database,
          `.show databases | where DatabaseName == '${database}'`,
        );

        // Check if the database was found
        // The query returns results in primaryResults[0]._rows (Kusto client library structure)
        const primaryResult = databaseCheckResult.primaryResults?.[0];
        const rows = (primaryResult as any)?._rows || [];

        if (
          !databaseCheckResult.primaryResults ||
          databaseCheckResult.primaryResults.length === 0 ||
          !primaryResult ||
          !rows ||
          rows.length === 0
        ) {
          throw new KustoConnectionError(
            `Database '${database}' not found in the cluster`,
          );
        }

        debugLog('Connection initialized successfully');
        span.setStatus({ code: SpanStatusCode.OK });

        return {
          success: true,
          cluster: clusterUrl,
          database: database,
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        criticalLog(`Failed to initialize connection: ${errorMessage}`);

        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: errorMessage,
        });

        throw new KustoConnectionError(`Connection error: ${errorMessage}`);
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

        // Execute the query with timeout
        const rawResult = await Promise.race([
          this.client.execute(database, query),
          new Promise((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new KustoQueryError(`Query timed out after ${timeout}ms`),
                ),
              timeout,
            ),
          ),
        ]);

        debugLog(`Raw Kusto Response: ${JSON.stringify(rawResult, null, 2)}`);

        // Convert the result to a JSON-friendly format
        // Cast the result to KustoQueryResult type
        const formattedResult = rawResult as KustoQueryResult;

        debugLog('Query executed successfully');
        span.setStatus({ code: SpanStatusCode.OK });

        return formattedResult;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        criticalLog(`Failed to execute query: ${errorMessage}`);

        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: errorMessage,
        });

        throw new KustoQueryError(`Failed to execute query: ${errorMessage}`);
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
