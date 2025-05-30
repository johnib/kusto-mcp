/**
 * Unit tests for connection management
 * These tests use recorded responses from E2E tests with mocked Kusto client
 */

import { KustoConnectionError } from '../../../src/common/errors.js';
import { KustoConnection } from '../../../src/operations/kusto/connection.js';
import {
  invalidClusterError,
  showDatabasesEmptyResponse,
  showDatabasesValidResponse,
  showFunctionsResponse,
  showTablesResponse,
  showVersionResponse,
} from '../fixtures/connection-responses.js';

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

describe('Connection Management Unit Tests', () => {
  let connection: KustoConnection;
  let mockClient: any;
  let mockExecute: jest.MockedFunction<any>;

  beforeAll(() => {
    // Use fake timers to mock setTimeout used in connection timeout
    jest.useFakeTimers();
  });

  afterAll(() => {
    // Restore real timers
    jest.useRealTimers();
  });

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Clear all timers to prevent open handles
    jest.clearAllTimers();

    // Get the mocked Client from the setup
    const { Client } = require('azure-kusto-data');
    mockExecute = jest.fn();
    mockClient = {
      execute: mockExecute,
    };
    Client.mockImplementation(() => mockClient);

    // Create a connection instance
    connection = new KustoConnection({
      authMethod: 'azure-cli' as any,
      queryTimeout: 30000,
    });
  });

  afterEach(() => {
    // Clear all mocks after each test
    jest.clearAllMocks();

    // Clear all timers to prevent open handles
    jest.clearAllTimers();

    // Reset modules to clean state
    jest.resetModules();

    // Clear any pending timeouts/intervals
    jest.runOnlyPendingTimers();
  });

  describe('Successful Operations', () => {
    test('should connect to help.kusto.windows.net successfully', async () => {
      // Setup mocks for successful connection
      mockExecute
        .mockResolvedValueOnce(showVersionResponse) // .show version
        .mockResolvedValueOnce(showDatabasesValidResponse); // .show databases check

      // Test the connection
      const result = await connection.initialize(
        'https://help.kusto.windows.net/',
        'ContosoSales',
      );

      // Verify the result
      expect(result).toEqual({
        success: true,
        cluster: 'https://help.kusto.windows.net/',
        database: 'ContosoSales',
      });

      // Verify the mock calls
      expect(mockExecute).toHaveBeenCalledTimes(2);
      expect(mockExecute).toHaveBeenNthCalledWith(
        1,
        'ContosoSales',
        '.show version',
      );
      expect(mockExecute).toHaveBeenNthCalledWith(
        2,
        'ContosoSales',
        ".show databases | where DatabaseName == 'ContosoSales'",
      );

      // Verify connection state
      expect(connection.isInitialized()).toBe(true);
      expect(connection.getDatabase()).toBe('ContosoSales');
    });

    test('should maintain connection state across multiple operations', async () => {
      // Setup mocks for initialization
      mockExecute
        .mockResolvedValueOnce(showVersionResponse)
        .mockResolvedValueOnce(showDatabasesValidResponse);

      // Initialize connection
      await connection.initialize(
        'https://help.kusto.windows.net/',
        'ContosoSales',
      );

      // Reset mock call count for testing subsequent operations
      mockExecute.mockClear();

      // Setup mocks for subsequent operations
      mockExecute
        .mockResolvedValueOnce(showTablesResponse) // show-tables operation
        .mockResolvedValueOnce(showFunctionsResponse); // show-functions operation

      // Test multiple operations
      const tablesResult = await connection.executeQuery(
        'ContosoSales',
        '.show tables',
      );
      const functionsResult = await connection.executeQuery(
        'ContosoSales',
        '.show functions | project Name, DocString',
      );

      // Verify results
      expect(tablesResult).toEqual(showTablesResponse);
      expect(functionsResult).toEqual(showFunctionsResponse);

      // Verify connection remains initialized
      expect(connection.isInitialized()).toBe(true);
      expect(connection.getDatabase()).toBe('ContosoSales');

      // Verify correct queries were executed
      expect(mockExecute).toHaveBeenCalledTimes(2);
      expect(mockExecute).toHaveBeenNthCalledWith(
        1,
        'ContosoSales',
        '.show tables',
      );
      expect(mockExecute).toHaveBeenNthCalledWith(
        2,
        'ContosoSales',
        '.show functions | project Name, DocString',
      );
    });

    test('should allow reconnection with different parameters', async () => {
      // First connection
      mockExecute
        .mockResolvedValueOnce(showVersionResponse)
        .mockResolvedValueOnce(showDatabasesValidResponse);

      const firstResult = await connection.initialize(
        'https://help.kusto.windows.net/',
        'ContosoSales',
      );

      expect(firstResult.success).toBe(true);
      expect(connection.getDatabase()).toBe('ContosoSales');

      // Reset mocks for second connection
      mockExecute.mockClear();

      // Second connection (should override the first)
      mockExecute
        .mockResolvedValueOnce(showVersionResponse)
        .mockResolvedValueOnce(showDatabasesValidResponse);

      const secondResult = await connection.initialize(
        'https://help.kusto.windows.net/',
        'ContosoSales',
      );

      expect(secondResult.success).toBe(true);
      expect(connection.getDatabase()).toBe('ContosoSales');

      // Verify both initialization sequences were called
      expect(mockExecute).toHaveBeenCalledTimes(2);
    });
  });

  describe('Error Scenarios', () => {
    test('should handle invalid cluster URL gracefully', async () => {
      // Setup mock to throw connection error
      const error = new Error(invalidClusterError.message);
      error.name = invalidClusterError.name;
      mockExecute.mockRejectedValue(error);

      // Test invalid cluster connection
      await expect(
        connection.initialize(
          'https://invalid-cluster.windows.net/',
          'ContosoSales',
        ),
      ).rejects.toThrow(KustoConnectionError);

      // Verify connection was attempted
      expect(mockExecute).toHaveBeenCalledWith('ContosoSales', '.show version');

      // Verify connection is not initialized
      expect(connection.isInitialized()).toBe(false);
    });

    test('should handle invalid database name gracefully', async () => {
      // Setup mocks: version check succeeds, database check returns empty
      mockExecute
        .mockResolvedValueOnce(showVersionResponse) // .show version succeeds
        .mockResolvedValueOnce(showDatabasesEmptyResponse); // database check returns empty

      // Test with non-existent database
      await expect(
        connection.initialize(
          'https://help.kusto.windows.net/',
          'NonExistentDatabase',
        ),
      ).rejects.toThrow(KustoConnectionError);

      // Verify both queries were executed
      expect(mockExecute).toHaveBeenCalledTimes(2);
      expect(mockExecute).toHaveBeenNthCalledWith(
        1,
        'NonExistentDatabase',
        '.show version',
      );
      expect(mockExecute).toHaveBeenNthCalledWith(
        2,
        'NonExistentDatabase',
        ".show databases | where DatabaseName == 'NonExistentDatabase'",
      );

      // Verify connection is not initialized
      expect(connection.isInitialized()).toBe(false);
    });

    test('should require connection initialization for other tools', async () => {
      // Ensure connection is not initialized
      expect(connection.isInitialized()).toBe(false);

      // Test that operations fail without initialization
      await expect(
        connection.executeQuery('ContosoSales', '.show tables'),
      ).rejects.toThrow('Connection not initialized');

      // Test that getDatabase fails without initialization
      expect(() => connection.getDatabase()).toThrow(KustoConnectionError);

      // Verify no client operations were attempted
      expect(mockExecute).not.toHaveBeenCalled();
    });
  });

  describe('Connection State Management', () => {
    test('should track initialization state correctly', async () => {
      // Initially not initialized
      expect(connection.isInitialized()).toBe(false);

      // Setup successful initialization
      mockExecute
        .mockResolvedValueOnce(showVersionResponse)
        .mockResolvedValueOnce(showDatabasesValidResponse);

      // After successful initialization
      await connection.initialize(
        'https://help.kusto.windows.net/',
        'ContosoSales',
      );

      expect(connection.isInitialized()).toBe(true);
      expect(connection.getDatabase()).toBe('ContosoSales');
    });

    test('should handle partial initialization failure correctly', async () => {
      // Setup: version check succeeds, database check fails
      mockExecute
        .mockResolvedValueOnce(showVersionResponse)
        .mockRejectedValueOnce(new Error('Database check failed'));

      // Test that failed initialization leaves connection uninitialized
      await expect(
        connection.initialize(
          'https://help.kusto.windows.net/',
          'ContosoSales',
        ),
      ).rejects.toThrow(KustoConnectionError);

      // Even though client was created, connection should not be considered initialized
      // due to validation failure
      expect(connection.isInitialized()).toBe(false);
    });
  });
});
