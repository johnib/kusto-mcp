import { KustoConnection } from './connection.js';
import { executeManagementCommand, executeQuery } from './queries.js';
import {
  showFunction,
  showFunctions,
  showTable,
  showTables,
} from './tables.js';

/**
 * Export all Kusto operations
 */
export {
  executeManagementCommand,
  executeQuery,
  KustoConnection,
  showFunction,
  showFunctions,
  showTable,
  showTables,
};

// Export new query transformation functions
export {
  executeQueryWithTransformation,
  transformQueryResult,
  type TransformedQueryResult,
} from './queries.js';

/**
 * Create an index for the operations in this module
 */
export default {
  KustoConnection,
  showTables,
  showTable,
  showFunctions,
  showFunction,
  executeQuery,
  executeManagementCommand,
};
