import { SpanStatusCode, trace } from "@opentelemetry/api";
import { KustoQueryError, KustoResourceNotFoundError } from "../../common/errors.js";
import { safeLog } from "../../common/utils.js";
import { KustoTableListItem, KustoTableSchema } from "../../types/kusto-interfaces.js";
import { KustoConnection } from "./connection.js";

// Create a tracer for this module
const tracer = trace.getTracer("kusto-tables");

/**
 * List tables in the current database
 * 
 * @param connection The Kusto connection
 * @returns A list of tables
 */
export async function showTables(connection: KustoConnection): Promise<KustoTableListItem[]> {
  return tracer.startActiveSpan("showTables", async (span) => {
    try {
      if (!connection.isInitialized()) {
        throw new KustoQueryError("Connection not initialized");
      }
      
      const database = connection.getDatabase();
      span.setAttribute("database", database);
      
      safeLog(`Listing tables in database: ${database}`);
      
      // Execute the query to list tables
      const result = await connection.executeQuery(database, ".show tables");
      span.setStatus({ code: SpanStatusCode.OK });
      
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      safeLog(`Failed to list tables: ${errorMessage}`);
      
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: errorMessage
      });
      
      throw new KustoQueryError(`Failed to list tables: ${errorMessage}`);
    } finally {
      span.end();
    }
  });
}

/**
 * Get the schema of a table
 * 
 * @param connection The Kusto connection
 * @param tableName The name of the table
 * @returns The table schema
 */
export async function showTable(connection: KustoConnection, tableName: string): Promise<KustoTableSchema> {
  return tracer.startActiveSpan("showTable", async (span) => {
    try {
      span.setAttribute("tableName", tableName);
      
      const database = connection.getDatabase();
      span.setAttribute("database", database);
      
      safeLog(`Getting schema for table: ${tableName} in database: ${database}`);
      
      if (!connection.isInitialized()) {
        throw new KustoQueryError("Connection not initialized");
      }
      
      // Execute the query to get the table schema
      const result = await connection.executeQuery(database, `.show table ${tableName}`);
      span.setStatus({ code: SpanStatusCode.OK });
      
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      safeLog(`Failed to get table schema: ${errorMessage}`);
      
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: errorMessage
      });
      
      if (error instanceof KustoResourceNotFoundError) {
        throw error;
      }
      
      throw new KustoQueryError(`Failed to get table schema: ${errorMessage}`);
    } finally {
      span.end();
    }
  });
}

/**
 * List functions in the current database
 * 
 * @param connection The Kusto connection
 * @returns A list of functions
 */
export async function showFunctions(connection: KustoConnection): Promise<any> {
  return tracer.startActiveSpan("showFunctions", async (span) => {
    try {
      if (!connection.isInitialized()) {
        throw new KustoQueryError("Connection not initialized");
      }

      const database = connection.getDatabase();
      span.setAttribute("database", database);

      safeLog(`Listing functions in database: ${database}`);

      // Execute the query to list functions
      const result = await connection.executeQuery(database, ".show functions");
      span.setStatus({ code: SpanStatusCode.OK });

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      safeLog(`Failed to list functions: ${errorMessage}`);

      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: errorMessage
      });

      throw new KustoQueryError(`Failed to list functions: ${errorMessage}`);
    } finally {
      span.end();
    }
  });
}
