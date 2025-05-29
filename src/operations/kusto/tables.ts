import { SpanStatusCode, trace } from '@opentelemetry/api';
import {
  KustoQueryError,
  KustoResourceNotFoundError,
} from '../../common/errors.js';
import { criticalLog, debugLog } from '../../common/utils.js';
import {
  KustoFunctionListItem,
  KustoFunctionSchema,
  KustoTableListItem,
  KustoTableSchema,
} from '../../types/kusto-interfaces.js';
import { KustoConnection } from './connection.js';

// Create a tracer for this module
const tracer = trace.getTracer('kusto-tables');

/**
 * List tables in the current database
 *
 * @param connection The Kusto connection
 * @returns A list of tables
 */
export async function showTables(
  connection: KustoConnection,
): Promise<KustoTableListItem[]> {
  return tracer.startActiveSpan('showTables', async span => {
    try {
      if (!connection.isInitialized()) {
        throw new KustoQueryError('Connection not initialized');
      }

      const database = connection.getDatabase();
      span.setAttribute('database', database);

      debugLog(`Listing tables in database: ${database}`);

      // Execute the query to list tables
      const result = await connection.executeQuery(database, '.show tables');

      // Extract the tables data from the Kusto response
      if (!result.primaryResults || result.primaryResults.length === 0) {
        throw new KustoQueryError(
          'No primary result found in show tables response',
        );
      }

      // For .show tables, the first (and typically only) primary result contains the data
      const primaryResult = result.primaryResults[0];

      if (!primaryResult) {
        throw new KustoQueryError(
          'No primary result found in show tables response',
        );
      }

      // The Kusto client library uses '_rows' for the actual row data
      const rowsData = (primaryResult as any)._rows || primaryResult.data;

      if (!rowsData || !Array.isArray(rowsData)) {
        throw new KustoQueryError(
          'No valid primary result with data found in show tables response',
        );
      }

      // Convert array rows to objects with proper column names
      // Based on .show tables schema: TableName, DatabaseName, Folder, DocString
      const tablesData = rowsData.map((row: any[]) => ({
        TableName: row[0],
        DatabaseName: row[1],
        Folder: row[2],
        DocString: row[3],
      }));
      debugLog(
        `Successfully retrieved ${tablesData.length} tables from database ${database}`,
      );

      span.setStatus({ code: SpanStatusCode.OK });

      return tablesData;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      criticalLog(`Failed to list tables: ${errorMessage}`);

      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: errorMessage,
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
export async function showTable(
  connection: KustoConnection,
  tableName: string,
): Promise<KustoTableSchema> {
  return tracer.startActiveSpan('showTable', async span => {
    try {
      span.setAttribute('tableName', tableName);

      const database = connection.getDatabase();
      span.setAttribute('database', database);

      debugLog(
        `Getting schema for table: ${tableName} in database: ${database}`,
      );

      if (!connection.isInitialized()) {
        throw new KustoQueryError('Connection not initialized');
      }

      // Execute the query to get the table schema using getschema
      const result = await connection.executeQuery(
        database,
        `${tableName} | getschema`,
      );

      // Extract the table schema data from the Kusto response
      if (!result.primaryResults || result.primaryResults.length === 0) {
        throw new KustoQueryError(
          'No primary result found in show table response',
        );
      }

      // Find the primary result that contains actual data (not metadata)
      const primaryResult =
        result.primaryResults.find(
          (pr: any) =>
            ((pr.data && pr.data.length > 0) ||
              ((pr as any)._rows && (pr as any)._rows.length > 0)) &&
            pr.name !== 'QueryStatus' &&
            !pr.name.startsWith('@'),
        ) || result.primaryResults[0];

      if (!primaryResult) {
        throw new KustoQueryError(
          'No primary result found in show table response',
        );
      }

      // The Kusto client library uses '_rows' for the actual row data
      const rowsData = (primaryResult as any)._rows || primaryResult.data;

      if (!rowsData || !Array.isArray(rowsData)) {
        throw new KustoQueryError(
          'No primary result with data found in show table response',
        );
      }

      // Convert array rows to objects with proper column names
      // For TableName | getschema, the structure is: ColumnName, ColumnOrdinal, DataType, CslType
      const columns = rowsData.map((row: any[], index: number) => ({
        name: row[0], // Column name
        type: row[3], // Use CSL type (row[3]) as it's more appropriate for Kusto
        ordinal: index,
        isNullable: true, // Default assumption
      }));

      // Create the complete table schema object
      const tableSchema: KustoTableSchema = {
        tableName: tableName,
        databaseName: database,
        columns: columns,
      };

      span.setStatus({ code: SpanStatusCode.OK });

      return tableSchema;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      criticalLog(`Failed to get table schema: ${errorMessage}`);

      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: errorMessage,
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
export async function showFunctions(
  connection: KustoConnection,
): Promise<KustoFunctionListItem[]> {
  return tracer.startActiveSpan('showFunctions', async span => {
    try {
      if (!connection.isInitialized()) {
        throw new KustoQueryError('Connection not initialized');
      }

      const database = connection.getDatabase();
      span.setAttribute('database', database);

      debugLog(`Listing functions in database: ${database}`);

      // Execute the query to list functions.
      // Get only the function name and docstring to reduce token consumption and focus the agent.
      const result = await connection.executeQuery(
        database,
        '.show functions | project Name, DocString',
      );

      // Extract the functions data from the Kusto response
      if (!result.primaryResults || result.primaryResults.length === 0) {
        throw new KustoQueryError(
          'No primary result found in show functions response',
        );
      }

      // Find the primary result that contains actual data (not metadata)
      const primaryResult =
        result.primaryResults.find(
          (pr: any) =>
            ((pr.data && pr.data.length > 0) ||
              ((pr as any)._rows && (pr as any)._rows.length > 0)) &&
            pr.name !== 'QueryStatus' &&
            !pr.name.startsWith('@'),
        ) || result.primaryResults[0];

      if (!primaryResult) {
        throw new KustoQueryError(
          'No primary result found in show functions response',
        );
      }

      // The Kusto client library uses '_rows' for the actual row data
      const rowsData = (primaryResult as any)._rows || primaryResult.data;

      if (!rowsData || !Array.isArray(rowsData)) {
        throw new KustoQueryError(
          'No primary result with data found in show functions response',
        );
      }

      // Convert array rows to objects with proper column names
      // Based on .show functions | project Name, DocString schema: Name, DocString
      const functionsData = rowsData.map((row: any[]) => ({
        Name: row[0], // Function name
        DocString: row[1], // Function docstring
      }));

      debugLog(
        `Successfully retrieved ${functionsData.length} functions from database ${database}`,
      );

      span.setStatus({ code: SpanStatusCode.OK });

      return functionsData;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      criticalLog(`Failed to list functions: ${errorMessage}`);

      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: errorMessage,
      });

      throw new KustoQueryError(`Failed to list functions: ${errorMessage}`);
    } finally {
      span.end();
    }
  });
}

/**
 * Get the details of a specific function
 *
 * @param connection The Kusto connection
 * @param functionName The name of the function
 * @returns The function details
 */
export async function showFunction(
  connection: KustoConnection,
  functionName: string,
): Promise<KustoFunctionSchema> {
  return tracer.startActiveSpan('showFunction', async span => {
    try {
      span.setAttribute('functionName', functionName);

      const database = connection.getDatabase();
      span.setAttribute('database', database);

      debugLog(
        `Getting details for function: ${functionName} in database: ${database}`,
      );

      if (!connection.isInitialized()) {
        throw new KustoQueryError('Connection not initialized');
      }

      // Execute the query to get the function details
      const result = await connection.executeQuery(
        database,
        `.show function ${functionName}`,
      );

      // Extract the function details data from the Kusto response
      if (!result.primaryResults || result.primaryResults.length === 0) {
        throw new KustoQueryError(
          'No primary result found in show function response',
        );
      }

      // Find the primary result that contains actual data (not metadata)
      const primaryResult =
        result.primaryResults.find(
          (pr: any) =>
            ((pr.data && pr.data.length > 0) ||
              ((pr as any)._rows && (pr as any)._rows.length > 0)) &&
            pr.name !== 'QueryStatus' &&
            !pr.name.startsWith('@'),
        ) || result.primaryResults[0];

      if (!primaryResult) {
        throw new KustoQueryError(
          'No primary result found in show function response',
        );
      }

      // The Kusto client library uses '_rows' for the actual row data
      const rowsData = (primaryResult as any)._rows || primaryResult.data;

      if (!rowsData || !Array.isArray(rowsData)) {
        throw new KustoQueryError(
          'No primary result with data found in show function response',
        );
      }

      if (rowsData.length === 0) {
        throw new KustoResourceNotFoundError(
          `Function '${functionName}' not found`,
        );
      }

      // Convert the first row (function details) to a proper function schema object
      // Based on .show function schema: Name, Parameters, Body, Folder, DocString
      const functionRow = rowsData[0];
      const functionSchema: KustoFunctionSchema = {
        Name: functionRow[0], // Function name
        Parameters: functionRow[1] || '', // Function parameters
        Body: functionRow[2] || '', // Function body
        Folder: functionRow[3] || '', // Folder (optional)
        DocString: functionRow[4] || '', // DocString (optional)
      };

      debugLog(
        `Successfully retrieved function details for ${functionName} from database ${database}`,
      );

      span.setStatus({ code: SpanStatusCode.OK });

      return functionSchema;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      criticalLog(`Failed to get function details: ${errorMessage}`);

      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: errorMessage,
      });

      if (error instanceof KustoResourceNotFoundError) {
        throw error;
      }

      throw new KustoQueryError(
        `Failed to get function details: ${errorMessage}`,
      );
    } finally {
      span.end();
    }
  });
}
