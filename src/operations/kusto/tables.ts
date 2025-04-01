import { SpanStatusCode, trace } from "@opentelemetry/api";
import { KustoQueryError, KustoResourceNotFoundError } from "../../common/errors.js";
import { getSchemaKey, safeLog, schemaCache } from "../../common/utils.js";
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
      
      if (!result || !result.tables || !result.tables[0] || !result.tables[0].rows) {
        return [];
      }
      
      // Map the result to a list of tables
      const tables: KustoTableListItem[] = result.tables[0].rows.map((row: any) => ({
        name: row.TableName || row.Name,
        database: database,
        folder: row.Folder,
        description: row.DocString
      }));
      
      safeLog(`Found ${tables.length} tables in database ${database}`);
      span.setStatus({ code: SpanStatusCode.OK });
      
      return tables;
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
      
      // Check if the schema is in the cache
      const cacheKey = getSchemaKey(database, tableName);
      const cachedSchema = schemaCache.get(cacheKey);
      
      if (cachedSchema) {
        safeLog(`Using cached schema for table: ${tableName}`);
        return {
          tableName: tableName,
          databaseName: database,
          columns: cachedSchema.columns.map(col => ({
            name: col.name,
            type: col.type
          }))
        };
      }
      
      // Execute the query to get the table schema
      const result = await connection.executeQuery(database, `.show table ${tableName}`);
      
      if (!result || !result.tables || !result.tables[0] || !result.tables[0].rows || result.tables[0].rows.length === 0) {
        throw new KustoResourceNotFoundError(`Table ${tableName} not found in database ${database}`);
      }
      
      // Get the columns from the result
      const columnsResult = await connection.executeQuery(database, `.show table ${tableName} schema as json`);
      
      if (!columnsResult || !columnsResult.tables || !columnsResult.tables[0] || !columnsResult.tables[0].rows || columnsResult.tables[0].rows.length === 0) {
        throw new KustoResourceNotFoundError(`Failed to get schema for table ${tableName}`);
      }
      
      // Parse the schema JSON
      const schemaJson = JSON.parse(columnsResult.tables[0].rows[0].Schema);
      
      // Map the schema to a table schema
      const tableSchema: KustoTableSchema = {
        tableName: tableName,
        databaseName: database,
        columns: schemaJson.OrderedColumns.map((col: any) => ({
          name: col.Name,
          type: col.Type,
          isNullable: col.IsNullable,
          ordinal: col.Ordinal,
          description: col.Description
        })),
        folder: result.tables[0].rows[0].Folder,
        description: result.tables[0].rows[0].DocString
      };
      
      // Cache the schema
      schemaCache.set(cacheKey, {
        name: tableName,
        columns: tableSchema.columns.map(col => ({
          name: col.name,
          type: col.type
        })),
        rows: []
      });
      
      safeLog(`Got schema for table: ${tableName}`);
      span.setStatus({ code: SpanStatusCode.OK });
      
      return tableSchema;
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
