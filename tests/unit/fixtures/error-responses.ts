/**
 * Recorded error responses from E2E tests
 * These responses capture actual error behaviors from Kusto client and MCP server
 */

// Invalid KQL syntax error
export const invalidSyntaxError = new Error(
  "Request is invalid and cannot be processed: Syntax error: SyntaxError:Query could not be parsed at 'invalid_syntax_here'",
);
invalidSyntaxError.name = 'KustoServiceError';

// Non-existent table error
export const nonExistentTableError = new Error(
  "Request is invalid and cannot be processed: Semantic error: SEM0100: 'NonExistentTable123' could not be resolved to a table, a table function or an external data source.",
);
nonExistentTableError.name = 'KustoServiceError';

// Authentication failure error (invalid cluster)
export const authenticationError = new Error(
  'getaddrinfo ENOTFOUND invalid-cluster-12345.windows.net',
);
authenticationError.name = 'Error';
(authenticationError as any).code = 'ENOTFOUND';
(authenticationError as any).errno = -3008;
(authenticationError as any).syscall = 'getaddrinfo';
(authenticationError as any).hostname = 'invalid-cluster-12345.windows.net';

// Timeout error for long-running queries
export const timeoutError = new Error('Query execution timeout');
timeoutError.name = 'TimeoutError';

// Database not found error
export const databaseNotFoundError = new Error(
  "Request is invalid and cannot be processed: Unknown database 'NonExistentDatabase123'",
);
databaseNotFoundError.name = 'KustoServiceError';

// Empty table response for database check
export const emptyDatabaseCheckResponse = {
  primaryResults: [
    {
      tableName: 'Table_0',
      tableId: 0,
      tableKind: 'PrimaryResult',
      columns: [
        {
          columnName: 'DatabaseName',
          columnType: 'string',
          dataType: 'System.String',
        },
      ],
      rows: [], // Empty rows means database doesn't exist
    },
  ],
  tables: [],
};

// Invalid function syntax error
export const invalidFunctionError = new Error(
  "Request is invalid and cannot be processed: Semantic error: SEM0100: 'invalid_function' could not be resolved to a function call.",
);
invalidFunctionError.name = 'KustoServiceError';

// Empty query error
export const emptyQueryError = new Error(
  'Request is invalid and cannot be processed: Query is empty',
);
emptyQueryError.name = 'KustoServiceError';

// Whitespace-only query error
export const whitespaceQueryError = new Error(
  'Request is invalid and cannot be processed: Query is empty',
);
whitespaceQueryError.name = 'KustoServiceError';

// Incomplete where clause error
export const incompleteWhereError = new Error(
  'Request is invalid and cannot be processed: Syntax error: SyntaxError:Incomplete query. Last line: | where',
);
incompleteWhereError.name = 'KustoServiceError';

// Invalid operator error
export const invalidOperatorError = new Error(
  "Request is invalid and cannot be processed: Syntax error: SyntaxError:Query could not be parsed at 'invalid_operator'",
);
invalidOperatorError.name = 'KustoServiceError';

// Large result set with partial results
export const largeResultSetPartialResponse = {
  primaryResults: [
    {
      tableName: 'Table_0',
      tableId: 0,
      tableKind: 'PrimaryResult',
      columns: [
        {
          columnName: 'i',
          columnType: 'long',
          dataType: 'System.Int64',
        },
        {
          columnName: 'data',
          columnType: 'string',
          dataType: 'System.String',
        },
      ],
      rows: [
        [1, 'large_data_1_0.123456789'],
        [2, 'large_data_2_0.987654321'],
      ],
    },
  ],
  tables: [],
  // This would have additional metadata in real response indicating partial results
};

// Parameter validation errors - these are at the MCP protocol level
export const missingParameterError = {
  error: {
    code: -32602,
    message: 'Invalid parameters',
    data: 'Missing required parameter: tableName',
  },
};

export const invalidParameterTypeError = {
  error: {
    code: -32602,
    message: 'Invalid parameters',
    data: 'Parameter "limit" must be a number',
  },
};

export const unknownToolError = {
  error: {
    code: -32601,
    message: 'Unknown tool: non-existent-tool',
  },
};

// Connection not initialized error
export const connectionNotInitializedError = new Error(
  'Connection not initialized. Please connect to a Kusto cluster first.',
);
connectionNotInitializedError.name = 'KustoConnectionError';

// Network error patterns
export const networkError = new Error(
  'Network error: Unable to connect to cluster',
);
networkError.name = 'NetworkError';
(networkError as any).code = 'ENETUNREACH';

// Create error response helper
export function createErrorResponse(error: Error): any {
  return {
    error: {
      code: -32603,
      message: error.message,
      data: {
        name: error.name,
        ...((error as any).code && { code: (error as any).code }),
      },
    },
  };
}

// Helper to create Kusto error responses
export function createKustoErrorResponse(error: Error): never {
  throw error;
}
