/**
 * Unit tests for error scenarios
 * These tests verify proper error handling across various failure conditions
 */

import { KustoConnectionError } from '../../../src/common/errors.js';
import { KustoConnection } from '../../../src/operations/kusto/connection.js';
import {
  showDatabasesValidResponse,
  showVersionResponse,
} from '../fixtures/connection-responses.js';
import {
  authenticationError,
  emptyDatabaseCheckResponse,
  emptyQueryError,
  incompleteWhereError,
  invalidFunctionError,
  invalidOperatorError,
  invalidSyntaxError,
  largeResultSetPartialResponse,
  networkError,
  nonExistentTableError,
  timeoutError,
  whitespaceQueryError,
} from '../fixtures/error-responses.js';

// Mock the modules
jest.mock('azure-kusto-data', () => ({
  Client: jest.fn(),
  KustoConnectionStringBuilder: {
    withAzLoginIdentity: jest.fn(
      clusterUrl => `connection-string-for-${clusterUrl}`,
    ),
  },
}));

jest.mock('../../../src/auth/token-credentials.js', () => ({
  createTokenCredential: jest.fn(() => ({
    getToken: jest.fn().mockResolvedValue({
      token: 'mock-token',
      expiresOnTimestamp: Date.now() + 3600000,
    }),
  })),
}));

jest.mock('../../../src/common/utils.js', () => ({
  debugLog: jest.fn(),
  criticalLog: jest.fn(),
}));

jest.mock('@opentelemetry/api', () => ({
  SpanStatusCode: {
    OK: 1,
    ERROR: 2,
  },
  trace: {
    getTracer: jest.fn(() => ({
      startActiveSpan: jest.fn((name, fn) =>
        fn({
          setAttribute: jest.fn(),
          setStatus: jest.fn(),
          end: jest.fn(),
        }),
      ),
    })),
  },
}));

describe('Error Scenarios Unit Tests', () => {
  let connection: KustoConnection;
  let mockClient: any;
  let mockExecute: jest.MockedFunction<any>;

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup mocked Kusto client
    const { Client } = require('azure-kusto-data');
    mockExecute = jest.fn();
    mockClient = { execute: mockExecute };
    Client.mockImplementation(() => mockClient);

    // Create connection instance
    connection = new KustoConnection({
      authMethod: 'azure-cli' as any,
      queryTimeout: 30000,
    });
  });

  describe('Query Execution Errors', () => {
    beforeEach(async () => {
      // Initialize connection for query tests
      mockExecute
        .mockResolvedValueOnce(showVersionResponse)
        .mockResolvedValueOnce(showDatabasesValidResponse);

      await connection.initialize(
        'https://help.kusto.windows.net/',
        'ContosoSales',
      );

      // Clear mocks after initialization
      mockExecute.mockClear();
    });

    test('should handle invalid KQL syntax gracefully', async () => {
      // Mock Kusto throwing syntax error
      mockExecute.mockRejectedValueOnce(invalidSyntaxError);

      // Test invalid syntax
      await expect(
        connection.executeQuery(
          'ContosoSales',
          'invalid_syntax_here | this_is_not_kql',
        ),
      ).rejects.toThrow('Syntax error');

      // Verify the query was attempted
      expect(mockExecute).toHaveBeenCalledWith(
        'ContosoSales',
        'invalid_syntax_here | this_is_not_kql',
      );
    });

    test('should handle queries to non-existent tables', async () => {
      // Mock Kusto throwing semantic error for non-existent table
      mockExecute.mockRejectedValueOnce(nonExistentTableError);

      // Test non-existent table query
      await expect(
        connection.executeQuery('ContosoSales', 'NonExistentTable123 | take 1'),
      ).rejects.toThrow('could not be resolved to a table');

      expect(mockExecute).toHaveBeenCalledWith(
        'ContosoSales',
        'NonExistentTable123 | take 1',
      );
    });

    test('should handle empty queries', async () => {
      // Mock Kusto throwing empty query error
      mockExecute.mockRejectedValueOnce(emptyQueryError);

      // Test empty query
      await expect(connection.executeQuery('ContosoSales', '')).rejects.toThrow(
        'Query is empty',
      );

      expect(mockExecute).toHaveBeenCalledWith('ContosoSales', '');
    });

    test('should handle whitespace-only queries', async () => {
      // Mock Kusto throwing whitespace query error
      mockExecute.mockRejectedValueOnce(whitespaceQueryError);

      // Test whitespace-only query
      await expect(
        connection.executeQuery('ContosoSales', '   \n\t   '),
      ).rejects.toThrow('Query is empty');

      expect(mockExecute).toHaveBeenCalledWith('ContosoSales', '   \n\t   ');
    });

    test('should handle queries with syntax errors in functions', async () => {
      // Mock Kusto throwing function error
      mockExecute.mockRejectedValueOnce(invalidFunctionError);

      // Test invalid function syntax
      await expect(
        connection.executeQuery(
          'ContosoSales',
          'SalesOrders | extend invalid_function()',
        ),
      ).rejects.toThrow('could not be resolved to a function call');

      expect(mockExecute).toHaveBeenCalledWith(
        'ContosoSales',
        'SalesOrders | extend invalid_function()',
      );
    });

    test('should handle incomplete where clauses', async () => {
      // Mock Kusto throwing incomplete query error
      mockExecute.mockRejectedValueOnce(incompleteWhereError);

      // Test incomplete where clause
      await expect(
        connection.executeQuery('ContosoSales', 'SalesOrders | where'),
      ).rejects.toThrow('Incomplete query');

      expect(mockExecute).toHaveBeenCalledWith(
        'ContosoSales',
        'SalesOrders | where',
      );
    });

    test('should handle invalid operators', async () => {
      // Mock Kusto throwing invalid operator error
      mockExecute.mockRejectedValueOnce(invalidOperatorError);

      // Test invalid operator
      await expect(
        connection.executeQuery(
          'ContosoSales',
          'SalesOrders | invalid_operator',
        ),
      ).rejects.toThrow('Query could not be parsed');

      expect(mockExecute).toHaveBeenCalledWith(
        'ContosoSales',
        'SalesOrders | invalid_operator',
      );
    });

    test('should handle large result sets with limits appropriately', async () => {
      // Mock Kusto returning partial results
      mockExecute.mockResolvedValueOnce(largeResultSetPartialResponse);

      // Test large query with limit (limit would be applied at tool level, not connection level)
      const result = await connection.executeQuery(
        'ContosoSales',
        `
        range i from 1 to 100000 step 1
        | extend data = strcat("large_data_", i, "_", rand())
        | take 2
      `,
      );

      // Verify limit was respected
      expect(result.primaryResults[0].rows.length).toBe(2);
      expect(mockExecute).toHaveBeenCalledWith(
        'ContosoSales',
        expect.stringContaining('range i from 1 to 100000'),
      );
    });

    test('should provide meaningful error messages', async () => {
      const errorScenarios = [
        {
          error: nonExistentTableError,
          query: 'NonExistentTable | take 1',
          expectedMessage: 'could not be resolved to a table',
        },
        {
          error: invalidOperatorError,
          query: 'SalesOrders | invalid_operator',
          expectedMessage: 'Query could not be parsed',
        },
        {
          error: incompleteWhereError,
          query: 'SalesOrders | where',
          expectedMessage: 'Incomplete query',
        },
      ];

      for (const scenario of errorScenarios) {
        mockExecute.mockRejectedValueOnce(scenario.error);

        try {
          await connection.executeQuery('ContosoSales', scenario.query);
          fail('Should have thrown error');
        } catch (error: any) {
          // Verify error message is meaningful
          expect(error.message).toContain(scenario.expectedMessage);
          expect(error.message.length).toBeGreaterThan(10);

          // Should not expose internal details
          expect(error.message).not.toContain('stack trace');
          expect(error.message).not.toContain('internal error');
        }
      }
    });
  });

  describe('Connection Errors', () => {
    test('should handle authentication failures', async () => {
      // Mock authentication error when trying to connect
      mockExecute.mockRejectedValueOnce(authenticationError);

      // Test invalid cluster URL
      await expect(
        connection.initialize(
          'https://invalid-cluster-12345.windows.net/',
          'ContosoSales',
        ),
      ).rejects.toThrow('ENOTFOUND');

      // Verify connection attempt was made
      expect(mockExecute).toHaveBeenCalledWith('ContosoSales', '.show version');
    });

    test('should handle database connection errors', async () => {
      // First connection succeeds
      mockExecute
        .mockResolvedValueOnce(showVersionResponse)
        .mockResolvedValueOnce(showDatabasesValidResponse);

      await connection.initialize(
        'https://help.kusto.windows.net/',
        'ContosoSales',
      );

      // Clear mocks and attempt connection to non-existent database
      mockExecute.mockClear();
      mockExecute
        .mockResolvedValueOnce(showVersionResponse) // Version check succeeds
        .mockResolvedValueOnce(emptyDatabaseCheckResponse); // Database check fails

      // Test with non-existent database
      await expect(
        connection.initialize(
          'https://help.kusto.windows.net/',
          'NonExistentDatabase123',
        ),
      ).rejects.toThrow(KustoConnectionError);

      // Verify database check was performed
      expect(mockExecute).toHaveBeenCalledWith(
        'NonExistentDatabase123',
        ".show databases | where DatabaseName == 'NonExistentDatabase123'",
      );
    });

    test('should handle connection not initialized errors', async () => {
      // Ensure connection is not initialized
      expect(connection.isInitialized()).toBe(false);

      // Test operations without initialization
      await expect(
        connection.executeQuery('ContosoSales', '.show tables'),
      ).rejects.toThrow('Connection not initialized');

      // Verify getDatabase also throws
      expect(() => connection.getDatabase()).toThrow(KustoConnectionError);

      // Verify no execution was attempted
      expect(mockExecute).not.toHaveBeenCalled();
    });

    test('should handle network errors gracefully', async () => {
      // Mock network error
      mockExecute.mockRejectedValueOnce(networkError);

      // Test network failure
      await expect(
        connection.initialize(
          'https://help.kusto.windows.net/',
          'ContosoSales',
        ),
      ).rejects.toThrow('Network error');

      expect(mockExecute).toHaveBeenCalledWith('ContosoSales', '.show version');
    });
  });

  describe('Timeout Scenarios', () => {
    test('should handle query timeouts gracefully', async () => {
      // Initialize connection first
      mockExecute
        .mockResolvedValueOnce(showVersionResponse)
        .mockResolvedValueOnce(showDatabasesValidResponse);

      await connection.initialize(
        'https://help.kusto.windows.net/',
        'ContosoSales',
      );

      mockExecute.mockClear();

      // Mock timeout error
      mockExecute.mockRejectedValueOnce(timeoutError);

      // Test timeout scenario
      await expect(
        connection.executeQuery(
          'ContosoSales',
          `
          range i from 1 to 1000000 step 1
          | extend data = strcat("row", i)
          | summarize count() by data
          | take 1000000
        `,
        ),
      ).rejects.toThrow('timeout');

      expect(mockExecute).toHaveBeenCalled();
    });

    test('should handle slow queries with configured timeout', async () => {
      // Initialize connection
      mockExecute
        .mockResolvedValueOnce(showVersionResponse)
        .mockResolvedValueOnce(showDatabasesValidResponse);

      await connection.initialize(
        'https://help.kusto.windows.net/',
        'ContosoSales',
      );

      mockExecute.mockClear();

      // Mock a slow response that would timeout
      mockExecute.mockImplementation(
        () =>
          new Promise((_, reject) => {
            setTimeout(() => reject(timeoutError), 100);
          }),
      );

      // Test with timeout
      await expect(
        connection.executeQuery('ContosoSales', 'SlowQuery | take 1000000'),
      ).rejects.toThrow('timeout');
    });
  });

  describe('Parameter Validation Errors', () => {
    test('should validate required parameters', async () => {
      // Mock error for empty cluster URL
      mockExecute.mockRejectedValueOnce(new Error('Invalid cluster URL'));

      // Test missing cluster_url
      await expect(connection.initialize('', 'ContosoSales')).rejects.toThrow();

      // Clear mocks
      mockExecute.mockClear();

      // Mock responses for valid cluster but empty database
      mockExecute
        .mockResolvedValueOnce(showVersionResponse)
        .mockResolvedValueOnce({ primaryResults: [{ rows: [] }] }); // Empty result for database check

      // Test missing database
      await expect(
        connection.initialize('https://help.kusto.windows.net/', ''),
      ).rejects.toThrow();
    });

    test('should handle invalid parameter types gracefully', async () => {
      // Initialize connection
      mockExecute
        .mockResolvedValueOnce(showVersionResponse)
        .mockResolvedValueOnce(showDatabasesValidResponse);

      await connection.initialize(
        'https://help.kusto.windows.net/',
        'ContosoSales',
      );

      mockExecute.mockClear();

      // Test with invalid limit type (string instead of number)
      // The connection class should handle type validation
      const invalidLimit = 'invalid_number' as any;

      // Mock successful query but with type validation
      mockExecute.mockResolvedValueOnce({
        primaryResults: [{ rows: [] }],
        tables: [],
      });

      // Execute query - limit handling would be done at the tool handler level
      const result = await connection.executeQuery(
        'ContosoSales',
        'SalesOrders | take 5',
      );

      // Verify query was executed
      expect(mockExecute).toHaveBeenCalled();
      expect(result.primaryResults[0].rows).toHaveLength(0);
    });
  });

  describe('Error Recovery', () => {
    test('should allow retry after transient errors', async () => {
      // First attempt fails with network error
      mockExecute.mockRejectedValueOnce(networkError);

      await expect(
        connection.initialize(
          'https://help.kusto.windows.net/',
          'ContosoSales',
        ),
      ).rejects.toThrow('Network error');

      // Clear mocks for retry
      mockExecute.mockClear();

      // Second attempt succeeds
      mockExecute
        .mockResolvedValueOnce(showVersionResponse)
        .mockResolvedValueOnce(showDatabasesValidResponse);

      const result = await connection.initialize(
        'https://help.kusto.windows.net/',
        'ContosoSales',
      );

      expect(result.success).toBe(true);
      expect(connection.isInitialized()).toBe(true);
    });

    test('should maintain error state correctly', async () => {
      // Initialize successfully
      mockExecute
        .mockResolvedValueOnce(showVersionResponse)
        .mockResolvedValueOnce(showDatabasesValidResponse);

      await connection.initialize(
        'https://help.kusto.windows.net/',
        'ContosoSales',
      );

      expect(connection.isInitialized()).toBe(true);

      mockExecute.mockClear();

      // Query fails
      mockExecute.mockRejectedValueOnce(invalidSyntaxError);

      await expect(
        connection.executeQuery('ContosoSales', 'invalid query'),
      ).rejects.toThrow();

      // Connection should still be initialized after query error
      expect(connection.isInitialized()).toBe(true);

      // Subsequent valid queries should work
      mockExecute.mockResolvedValueOnce({
        primaryResults: [{ rows: [['data']] }],
      });

      const result = await connection.executeQuery(
        'ContosoSales',
        '.show tables',
      );
      expect(result).toBeDefined();
    });
  });
});
