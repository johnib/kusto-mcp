import { SpanStatusCode, trace } from '@opentelemetry/api';
import { KustoQueryError } from '../../common/errors.js';
import { criticalLog, debugLog } from '../../common/utils.js';
import { KustoQueryResult } from '../../types/kusto-interfaces.js';
import { KustoConfig } from '../../types/config.js';
import { KustoConnection } from './connection.js';

export interface TransformedQueryResult {
  name?: string;
  data: Array<Record<string, any>>;
  rawResult: KustoQueryResult;
  queryStatistics?: {
    totalCpu?: string;
    executionTime?: string;
    extentsTotal?: number;
    extentsScanned?: number;
    resourceUsage?: Record<string, any>;
  };
}

// Create a tracer for this module
const tracer = trace.getTracer('kusto-queries');

/**
 * Extract query statistics from Kusto response, including CPU and execution time
 *
 * @param rawResult The raw result from Kusto
 * @returns Query statistics object
 */
function extractQueryStatistics(rawResult: KustoQueryResult): {
  totalCpu?: string;
  executionTime?: string;
  extentsTotal?: number;
  extentsScanned?: number;
  resourceUsage?: Record<string, any>;
} {
  const statistics: {
    totalCpu?: string;
    executionTime?: string;
    extentsTotal?: number;
    extentsScanned?: number;
    resourceUsage?: Record<string, any>;
  } = {};

  try {
    const rawAny = rawResult as any;

    // Try different data access patterns for QueryCompletionInformation
    let queryCompletionTable = null;

    // Check statusTable first
    if (
      rawAny.statusTable &&
      rawAny.statusTable.name === 'QueryCompletionInformation'
    ) {
      // Try _rows if data is empty
      if (
        (!rawAny.statusTable.data || rawAny.statusTable.data.length === 0) &&
        rawAny.statusTable._rows &&
        rawAny.statusTable._rows.length > 0
      ) {
        rawAny.statusTable.data = rawAny.statusTable._rows;
      }

      if (rawAny.statusTable.data && rawAny.statusTable.data.length > 0) {
        queryCompletionTable = rawAny.statusTable;
      }
    }

    // Fallback to tables array
    if (!queryCompletionTable) {
      const allTables = rawAny.tables || [];
      const foundTable = allTables.find(
        (table: any) => table.name === 'QueryCompletionInformation',
      );
      if (foundTable) {
        // Try _rows if data is empty
        if (
          (!foundTable.data || foundTable.data.length === 0) &&
          foundTable._rows &&
          foundTable._rows.length > 0
        ) {
          foundTable.data = foundTable._rows;
        }

        if (foundTable.data && foundTable.data.length > 0) {
          queryCompletionTable = foundTable;
        }
      }
    }

    if (
      queryCompletionTable &&
      queryCompletionTable.data &&
      queryCompletionTable.data.length > 0
    ) {
      // Get column metadata to understand the structure
      const columns = queryCompletionTable.columns || [];

      // Convert raw array rows to objects using column metadata
      const convertedRows = queryCompletionTable.data.map((rowArray: any[]) => {
        const obj: any = {};
        if (columns && columns.length > 0) {
          columns.forEach((column: any, columnIndex: number) => {
            const columnName =
              column.ColumnName || column.name || `Column${columnIndex}`;
            obj[columnName] = rowArray[columnIndex];
          });
        } else {
          // Fallback: use generic column names
          rowArray.forEach((value: any, colIndex: number) => {
            obj[`Column${colIndex}`] = value;
          });
        }
        return obj;
      });

      // Look for the row with EventTypeName: "QueryResourceConsumption"
      const resourceConsumptionRow = convertedRows.find(
        (row: any) => row.EventTypeName === 'QueryResourceConsumption',
      );

      if (resourceConsumptionRow && resourceConsumptionRow.Payload) {
        try {
          const payload = JSON.parse(resourceConsumptionRow.Payload);

          if (payload.resource_usage) {
            const resourceUsage = payload.resource_usage;

            // Extract CPU information (keep)
            if (resourceUsage.cpu && resourceUsage.cpu['total cpu']) {
              statistics.totalCpu = resourceUsage.cpu['total cpu'];
            }
          }

          // Extract execution time (keep)
          if (payload.ExecutionTime !== undefined) {
            statistics.executionTime = `${payload.ExecutionTime}s`;
          }

          // Extract extents statistics (keep)
          if (
            payload.input_dataset_statistics &&
            payload.input_dataset_statistics.extents
          ) {
            const extents = payload.input_dataset_statistics.extents;
            if (extents.total !== undefined) {
              statistics.extentsTotal = extents.total;
            }
            if (extents.scanned !== undefined) {
              statistics.extentsScanned = extents.scanned;
            }
          }

          // Store all resource usage data for debugging
          statistics.resourceUsage = { ...payload };
        } catch (parseError) {
          debugLog(
            `Error parsing QueryResourceConsumption payload: ${parseError}`,
          );
        }
      }

      // Also check for other patterns like direct TotalCpu fields
      const completionData = convertedRows[0] || {};

      // Extract common fields that might contain CPU/timing info
      if (completionData.TotalCpu !== undefined) {
        statistics.totalCpu = String(completionData.TotalCpu);
      }
      if (completionData.ExecutionTime !== undefined) {
        statistics.executionTime = String(completionData.ExecutionTime);
      }
      if (completionData.Duration !== undefined) {
        statistics.executionTime = String(completionData.Duration);
      }
    }

    // Also check in primaryResults for any statistics tables
    const primaryResults = rawResult.primaryResults || [];
    for (const result of primaryResults) {
      if (result.name && result.name.toLowerCase().includes('completion')) {
        debugLog(
          `Found completion info in primaryResults: ${JSON.stringify(result)}`,
        );
        // Extract any additional statistics if found
      }
    }

    // Look for dataSetCompletion which might contain timing info
    const dataSetCompletion = rawAny.dataSetCompletion;
    if (dataSetCompletion) {
      debugLog(`DataSetCompletion found: ${JSON.stringify(dataSetCompletion)}`);
      // Some Kusto responses include timing in dataSetCompletion
    }

    debugLog(`Extracted statistics: ${JSON.stringify(statistics)}`);
  } catch (error) {
    debugLog(`Error extracting query statistics: ${error}`);
  }

  return statistics;
}

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
      let errorMessage = error instanceof Error ? error.message : String(error);

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

      throw new KustoQueryError(errorMessage);
    } finally {
      span.end();
    }
  });
}

/**
 * Transform raw Kusto query results into structured objects using column metadata
 *
 * @param rawResult The raw result from Kusto
 * @param config Optional configuration to control feature extraction
 * @returns Transformed result with proper object structure
 */
export function transformQueryResult(
  rawResult: KustoQueryResult,
  config?: KustoConfig,
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
  const transformedRows = rawRows.map((row: any[]) => {
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

    return obj;
  });

  debugLog(
    `Transformation complete: ${transformedRows.length} rows transformed`,
  );

  // Extract query statistics only if feature is enabled
  const queryStatistics = config?.enableQueryStatistics
    ? extractQueryStatistics(rawResult)
    : undefined;

  const result: TransformedQueryResult = {
    name: primaryResult.name || 'query_result',
    data: transformedRows,
    rawResult,
  };

  // Only include queryStatistics if enabled and has data
  if (queryStatistics && Object.keys(queryStatistics).length > 0) {
    result.queryStatistics = queryStatistics;
  }

  return result;
}

/**
 * Execute a query and return transformed results
 *
 * @param connection The Kusto connection
 * @param query The query to execute
 * @param config Optional configuration to control feature extraction
 * @returns The transformed result
 */
export async function executeQueryWithTransformation(
  connection: KustoConnection,
  query: string,
  config?: KustoConfig,
): Promise<TransformedQueryResult> {
  return tracer.startActiveSpan(
    'executeQueryWithTransformation',
    async span => {
      try {
        span.setAttribute('query', query);

        // Execute the raw query
        const rawResult = await executeQuery(connection, query);

        // Transform the result using column metadata
        const transformedResult = transformQueryResult(rawResult, config);

        span.setStatus({ code: SpanStatusCode.OK });
        return transformedResult;
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

        criticalLog(`Failed to execute and transform query: ${errorMessage}`);

        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: errorMessage,
        });

        // Don't double-wrap if it's already a KustoQueryError from executeQuery
        if (error instanceof KustoQueryError) {
          throw error;
        }

        throw new KustoQueryError(errorMessage);
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
      let errorMessage = error instanceof Error ? error.message : String(error);

      // Extract detailed error message from Kusto response if available
      if (error && typeof error === 'object' && 'response' in error) {
        const response = (error as any).response;
        if (response?.data?.error?.['@message']) {
          errorMessage = response.data.error['@message'];
        } else if (response?.data?.error?.message) {
          errorMessage = response.data.error.message;
        }
      }

      criticalLog(`Failed to execute management command: ${errorMessage}`);

      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: errorMessage,
      });

      throw new KustoQueryError(errorMessage);
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
