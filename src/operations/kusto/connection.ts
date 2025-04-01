import { Client, KustoConnectionStringBuilder } from "@azure/data-explorer-js";
import { TokenCredential } from "@azure/identity";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { createTokenCredential } from "../../auth/token-credentials.js";
import { KustoConnectionError, KustoQueryError } from "../../common/errors.js";
import { kustoResultToJson, safeLog } from "../../common/utils.js";
import { KustoConfig } from "../../types/config.js";

// Create a tracer for this module
const tracer = trace.getTracer("kusto-connection");

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
    safeLog(`KustoConnection created with cluster URL: ${config.clusterUrl}`);
  }
  
  /**
   * Initialize the connection to the Kusto cluster
   * 
   * @param clusterUrl The URL of the Kusto cluster
   * @param database The database to connect to
   * @returns The result of the connection test
   */
  async initialize(clusterUrl: string, database: string): Promise<any> {
    return tracer.startActiveSpan("initialize", async (span) => {
      try {
        span.setAttribute("clusterUrl", clusterUrl);
        span.setAttribute("database", database);
        
        safeLog(`Initializing connection to ${clusterUrl}, database: ${database}`);
        
        const connectionString = KustoConnectionStringBuilder.withAadTokenCredentialAuthentication(
          clusterUrl,
          this.tokenCredential
        );
        
        this.client = new Client(connectionString);
        this.database = database;
        
        // Test the connection by executing a simple query
        const result = await this.executeQuery(database, ".show version");
        
        safeLog("Connection initialized successfully");
        span.setStatus({ code: SpanStatusCode.OK });
        
        return result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        safeLog(`Failed to initialize connection: ${errorMessage}`);
        
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: errorMessage
        });
        
        throw new KustoConnectionError(`Failed to connect to Kusto cluster: ${errorMessage}`);
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
    return tracer.startActiveSpan("executeQuery", async (span) => {
      try {
        span.setAttribute("database", database);
        span.setAttribute("query", query);
        
        if (!this.client) {
          throw new KustoConnectionError("Connection not initialized");
        }
        
        safeLog(`Executing query on database ${database}: ${query}`);
        
        // Set timeout from config
        const timeout = this.config.queryTimeout || 60000;
        
        // Execute the query with timeout
        const result = await Promise.race([
          this.client.execute(database, query),
          new Promise((_, reject) => 
            setTimeout(() => reject(new KustoQueryError(`Query timed out after ${timeout}ms`)), timeout)
          )
        ]);
        
        // Convert the result to a JSON-friendly format
        const formattedResult = kustoResultToJson(result);
        
        safeLog("Query executed successfully");
        span.setStatus({ code: SpanStatusCode.OK });
        
        return formattedResult;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        safeLog(`Failed to execute query: ${errorMessage}`);
        
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: errorMessage
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
      throw new KustoConnectionError("Connection not initialized");
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
