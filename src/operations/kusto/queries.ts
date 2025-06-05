import { SpanStatusCode, trace } from '@opentelemetry/api';
import { KustoQueryError } from '../../common/errors.js';
import { criticalLog, debugLog } from '../../common/utils.js';
import { KustoQueryResult } from '../../types/kusto-interfaces.js';
import { KustoConnection } from './connection.js';

export interface TransformedQueryResult {
  name?: string;
  data: Array<Record<string, any>>;
  rawResult: KustoQueryResult;
}

// Create a tracer for this module
const tracer = trace.getTracer('kusto-queries');

/**
 * Execute a query on the Kusto cluster
 *
 * @param connection The Kusto connection
 * @param query The query to execute
 * @returns The result of the query
 */
export async function executeQuery(
  connection: KustoConnection,
  query: string,
): Promise<KustoQueryResult> {
  return tracer.startActiveSpan('executeQuery', async span => {
    try {
      span.setAttribute('query', query);

      debugLog(`Executing query: ${query}`);

      if (!connection.isInitialized()) {
        throw new KustoQueryError('Connection not initialized');
      }

      const database = connection.getDatabase();
      span.setAttribute('database', database);

      // Execute the query
      const result = await connection.executeQuery(database, query);

      debugLog('Query executed successfully');
      span.setStatus({ code: SpanStatusCode.OK });

      return result;
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
 * Transform raw Kusto query results into structured objects using column metadata
 *
 * @param rawResult The raw result from Kusto
 * @returns Transformed result with proper object structure
 */
export function transformQueryResult(
  rawResult: KustoQueryResult,
): TransformedQueryResult {
  debugLog('Transforming query result using column metadata');

  if (!rawResult.primaryResults || rawResult.primaryResults.length === 0) {
    debugLog('No primary results found');
    return {
      name: 'query_result',
      data: [],
      rawResult,
    };
  }

  const primaryResult = rawResult.primaryResults[0];
  const rawRows = (primaryResult as any)._rows || [];
  const columns = (primaryResult as any).columns || [];

  debugLog(`Found ${rawRows.length} rows and ${columns.length} columns`);
  debugLog(`Columns: ${JSON.stringify(columns)}`);

  // Transform raw array data to objects using ONLY column metadata
  const transformedRows = rawRows.map((row: any[], rowIndex: number) => {
    const obj: any = {};

    if (columns && columns.length > 0) {
      // Use column metadata - this is the CORRECT approach
      columns.forEach((column: any, columnIndex: number) => {
        const columnName =
          column.ColumnName || column.name || `Column${columnIndex}`;
        obj[columnName] = row[columnIndex];
      });
    } else {
      // Fallback: use generic column names when no metadata available
      row.forEach((value: any, index: number) => {
        obj[`Column${index}`] = value;
      });
    }

    debugLog(`Row ${rowIndex}: ${JSON.stringify(obj)}`);
    return obj;
  });

  debugLog(
    `Transformation complete: ${transformedRows.length} rows transformed`,
  );

  return {
    name: primaryResult.name || 'query_result',
    data: transformedRows,
    rawResult,
  };
}

/**
 * Execute a query and return transformed results
 *
 * @param connection The Kusto connection
 * @param query The query to execute
 * @returns The transformed result
 */
export async function executeQueryWithTransformation(
  connection: KustoConnection,
  query: string,
): Promise<TransformedQueryResult> {
  return tracer.startActiveSpan(
    'executeQueryWithTransformation',
    async span => {
      try {
        span.setAttribute('query', query);

        // Execute the raw query
        const rawResult = await executeQuery(connection, query);

        // Transform the result using column metadata
        const transformedResult = transformQueryResult(rawResult);

        span.setStatus({ code: SpanStatusCode.OK });
        return transformedResult;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        criticalLog(`Failed to execute and transform query: ${errorMessage}`);

        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: errorMessage,
        });

        throw new KustoQueryError(
          `Failed to execute and transform query: ${errorMessage}`,
        );
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Execute a management command on the Kusto cluster
 *
 * @param connection The Kusto connection
 * @param command The command to execute
 * @returns The result of the command
 */
export async function executeManagementCommand(
  connection: KustoConnection,
  command: string,
): Promise<any> {
  return tracer.startActiveSpan('executeManagementCommand', async span => {
    try {
      span.setAttribute('command', command);

      debugLog(`Executing management command: ${command}`);

      if (!connection.isInitialized()) {
        throw new KustoQueryError('Connection not initialized');
      }

      const database = connection.getDatabase();
      span.setAttribute('database', database);

      // Execute the command
      const result = await connection.executeQuery(database, command);

      debugLog('Management command executed successfully');
      span.setStatus({ code: SpanStatusCode.OK });

      return result;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      criticalLog(`Failed to execute management command: ${errorMessage}`);

      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: errorMessage,
      });

      throw new KustoQueryError(
        `Failed to execute management command: ${errorMessage}`,
      );
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
  executeQueryWithTransformation,
  transformQueryResult,
  executeManagementCommand,
};
