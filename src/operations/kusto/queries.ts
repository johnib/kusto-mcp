import { SpanStatusCode, trace } from "@opentelemetry/api";
import { KustoQueryError } from "../../common/errors.js";
import { safeLog } from "../../common/utils.js";
import { KustoQueryResult } from "../../types/kusto-interfaces.js";
import { KustoConnection } from "./connection.js";

// Create a tracer for this module
const tracer = trace.getTracer("kusto-queries");

/**
 * Execute a query on the Kusto cluster
 * 
 * @param connection The Kusto connection
 * @param query The query to execute
 * @returns The result of the query
 */
export async function executeQuery(connection: KustoConnection, query: string): Promise<KustoQueryResult> {
  return tracer.startActiveSpan("executeQuery", async (span) => {
    try {
      span.setAttribute("query", query);
      
      safeLog(`Executing query: ${query}`);
      
      if (!connection.isInitialized()) {
        throw new KustoQueryError("Connection not initialized");
      }
      
      const database = connection.getDatabase();
      span.setAttribute("database", database);
      
      // Execute the query
      const result = await connection.executeQuery(database, query);
      
      safeLog("Query executed successfully");
      span.setStatus({ code: SpanStatusCode.OK });
      
      return result;
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
 * Execute a management command on the Kusto cluster
 * 
 * @param connection The Kusto connection
 * @param command The command to execute
 * @returns The result of the command
 */
export async function executeManagementCommand(connection: KustoConnection, command: string): Promise<any> {
  return tracer.startActiveSpan("executeManagementCommand", async (span) => {
    try {
      span.setAttribute("command", command);
      
      safeLog(`Executing management command: ${command}`);
      
      if (!connection.isInitialized()) {
        throw new KustoQueryError("Connection not initialized");
      }
      
      const database = connection.getDatabase();
      span.setAttribute("database", database);
      
      // Execute the command
      const result = await connection.executeQuery(database, command);
      
      safeLog("Management command executed successfully");
      span.setStatus({ code: SpanStatusCode.OK });
      
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      safeLog(`Failed to execute management command: ${errorMessage}`);
      
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: errorMessage
      });
      
      throw new KustoQueryError(`Failed to execute management command: ${errorMessage}`);
    } finally {
      span.end();
    }
  });
}

/**
 * Create an index for the operations in this module
 */
export default {
  executeQuery,
  executeManagementCommand
};
