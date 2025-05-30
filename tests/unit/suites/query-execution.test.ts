/**
 * Unit tests for query execution functionality
 * These tests use recorded responses from E2E tests with mocked Kusto client
 */

import { KustoConnection } from '../../../src/operations/kusto/connection.js';
import { executeQuery } from '../../../src/operations/kusto/queries.js';
import { showTables } from '../../../src/operations/kusto/tables.js';
import {
  queryExecutionResponses,
  tablesListResponse,
} from '../fixtures/query-execution-responses.js';

// Create mock connection factory
const createMockConnection = () => {
  const mockConnection = {
    isInitialized: jest.fn().mockReturnValue(true),
    getDatabase: jest.fn().mockReturnValue('ContosoSales'),
    executeQuery: jest.fn(),
  } as unknown as KustoConnection;

  return mockConnection;
};

describe('Query Execution Unit Tests', () => {
  let mockConnection: KustoConnection;

  beforeEach(() => {
    mockConnection = createMockConnection();
  });

  test('should execute simple table query with take limit', async () => {
    // Arrange: Mock the executeQuery response
    (mockConnection.executeQuery as jest.Mock).mockResolvedValue(
      queryExecutionResponses.simpleTableQuery,
    );

    // Act: Call the function under test
    const result = await executeQuery(mockConnection, 'SalesFact | take 5');

    // Assert: Verify the behavior
    expect(result).toBeDefined();
    expect(result.primaryResults).toBeDefined();
    expect(result.primaryResults.length).toBeGreaterThan(0);

    const primaryResult = result.primaryResults[0];
    expect(primaryResult.data).toBeDefined();
    expect(Array.isArray(primaryResult.data)).toBe(true);
    expect(primaryResult.data.length).toBeGreaterThan(0);

    // Verify the actual data structure matches recorded response
    const firstRow = primaryResult.data[0];
    expect(firstRow).toHaveProperty('SalesAmount');
    expect(firstRow).toHaveProperty('TotalCost');
    expect(firstRow).toHaveProperty('DateKey');
    expect(firstRow).toHaveProperty('ProductKey');
    expect(firstRow).toHaveProperty('CustomerKey');

    // Verify data types are preserved
    expect(typeof firstRow.SalesAmount).toBe('number');
    expect(typeof firstRow.ProductKey).toBe('number');
    expect(typeof firstRow.DateKey).toBe('string');

    // Verify the executeQuery was called with correct parameters
    expect(mockConnection.executeQuery).toHaveBeenCalledWith(
      'ContosoSales',
      'SalesFact | take 5',
    );
  });

  test('should execute count query and return single row', async () => {
    // Arrange: Mock count query response
    const countResponse = {
      primaryResults: [
        {
          name: 'PrimaryResult',
          data: [{ Count: 2832193 }],
          _rows: [[2832193]],
        },
      ],
    };

    (mockConnection.executeQuery as jest.Mock).mockResolvedValue(countResponse);

    // Act: Call the function under test
    const result = await executeQuery(mockConnection, 'SalesFact | count');

    // Assert: Verify the result
    expect(result).toBeDefined();
    expect(result.primaryResults).toBeDefined();
    expect(result.primaryResults.length).toBeGreaterThan(0);

    const primaryResult = result.primaryResults[0];
    expect(primaryResult.data.length).toBe(1);

    // The row should contain a count value
    const countRow = primaryResult.data[0];
    expect(countRow).toHaveProperty('Count');
    expect(typeof countRow.Count).toBe('number');
    expect(countRow.Count).toBeGreaterThan(0);

    // Verify the executeQuery was called with correct parameters
    expect(mockConnection.executeQuery).toHaveBeenCalledWith(
      'ContosoSales',
      'SalesFact | count',
    );
  });

  test('should execute management command: .show tables', async () => {
    // Arrange: Mock the management command response
    (mockConnection.executeQuery as jest.Mock).mockResolvedValue(
      tablesListResponse,
    );

    // Act: Call the function under test
    const result = await executeQuery(mockConnection, '.show tables');

    // Assert: Verify the result
    expect(result).toBeDefined();
    expect(result.primaryResults).toBeDefined();
    expect(result.primaryResults.length).toBeGreaterThan(0);

    const primaryResult = result.primaryResults[0];
    expect(primaryResult.data.length).toBeGreaterThan(0);

    // Each row should have table information
    primaryResult.data.forEach((table: any) => {
      expect(table).toHaveProperty('TableName');
      expect(typeof table.TableName).toBe('string');
      expect(table.TableName.trim()).toBeTruthy();
    });

    // Verify specific tables exist from the recorded response
    const tableNames = primaryResult.data.map((table: any) => table.TableName);
    expect(tableNames).toContain('SalesFact');
    expect(tableNames).toContain('Products');

    // Verify the executeQuery was called with correct parameters
    expect(mockConnection.executeQuery).toHaveBeenCalledWith(
      'ContosoSales',
      '.show tables',
    );
  });

  test('should execute aggregation query', async () => {
    // Arrange: Mock aggregation query response
    const aggregationResponse = {
      primaryResults: [
        {
          name: 'PrimaryResult',
          data: [{ Count: 1547892 }],
          _rows: [[1547892]],
        },
      ],
    };

    (mockConnection.executeQuery as jest.Mock).mockResolvedValue(
      aggregationResponse,
    );

    // Act: Call the function under test
    const result = await executeQuery(
      mockConnection,
      'SalesFact | summarize Count = count() | take 1',
    );

    // Assert: Verify the result
    expect(result).toBeDefined();
    expect(result.primaryResults).toBeDefined();
    expect(result.primaryResults.length).toBeGreaterThan(0);

    const primaryResult = result.primaryResults[0];
    expect(primaryResult.data.length).toBe(1);

    // Should return aggregation result
    const aggregationRow = primaryResult.data[0];
    expect(aggregationRow).toHaveProperty('Count');
    expect(typeof aggregationRow.Count).toBe('number');
    expect(aggregationRow.Count).toBeGreaterThan(0);

    // Verify the executeQuery was called with correct parameters
    expect(mockConnection.executeQuery).toHaveBeenCalledWith(
      'ContosoSales',
      'SalesFact | summarize Count = count() | take 1',
    );
  });

  test('should handle queries that return no results', async () => {
    // Arrange: Mock empty response
    const emptyResponse = {
      primaryResults: [
        {
          name: 'PrimaryResult',
          data: [],
          _rows: [],
        },
      ],
    };

    (mockConnection.executeQuery as jest.Mock).mockResolvedValue(emptyResponse);

    // Act: Call the function under test
    const result = await executeQuery(
      mockConnection,
      'SalesFact | where 1 == 0',
    );

    // Assert: Should return empty results gracefully
    expect(result).toBeDefined();
    expect(result.primaryResults).toBeDefined();
    expect(result.primaryResults.length).toBeGreaterThan(0);

    const primaryResult = result.primaryResults[0];
    expect(primaryResult.data).toEqual([]);

    // Verify the executeQuery was called with correct parameters
    expect(mockConnection.executeQuery).toHaveBeenCalledWith(
      'ContosoSales',
      'SalesFact | where 1 == 0',
    );
  });

  test('should handle schema exploration queries', async () => {
    // Arrange: Mock schema exploration response
    const schemaResponse = {
      primaryResults: [
        {
          name: 'PrimaryResult',
          data: [
            {
              ColumnName: 'SalesAmount',
              ColumnType: 'System.Double',
              ColumnOrdinal: 0,
            },
            {
              ColumnName: 'TotalCost',
              ColumnType: 'System.Double',
              ColumnOrdinal: 1,
            },
            {
              ColumnName: 'DateKey',
              ColumnType: 'System.DateTime',
              ColumnOrdinal: 2,
            },
          ],
          _rows: [
            ['SalesAmount', 0, 'System.Double', 'real'],
            ['TotalCost', 1, 'System.Double', 'real'],
            ['DateKey', 2, 'System.DateTime', 'datetime'],
          ],
        },
      ],
    };

    (mockConnection.executeQuery as jest.Mock).mockResolvedValue(
      schemaResponse,
    );

    // Act: Call the function under test
    const result = await executeQuery(mockConnection, 'SalesFact | getschema');

    // Assert: Should return schema information
    expect(result).toBeDefined();
    expect(result.primaryResults).toBeDefined();
    expect(result.primaryResults.length).toBeGreaterThan(0);

    const primaryResult = result.primaryResults[0];
    expect(primaryResult.data.length).toBeGreaterThan(0);

    // Each row should have column information
    primaryResult.data.forEach((column: any) => {
      expect(column).toHaveProperty('ColumnName');
      expect(column).toHaveProperty('ColumnType');
      expect(typeof column.ColumnName).toBe('string');
      expect(typeof column.ColumnType).toBe('string');
    });

    // Verify specific columns from the mock response
    const columnNames = primaryResult.data.map((col: any) => col.ColumnName);
    expect(columnNames).toContain('SalesAmount');
    expect(columnNames).toContain('TotalCost');
    expect(columnNames).toContain('DateKey');

    // Verify the executeQuery was called with correct parameters
    expect(mockConnection.executeQuery).toHaveBeenCalledWith(
      'ContosoSales',
      'SalesFact | getschema',
    );
  });

  test('should preserve column types in query results', async () => {
    // Arrange: Mock response with various data types
    const singleRowResponse = {
      primaryResults: [
        {
          name: 'PrimaryResult',
          data: [
            queryExecutionResponses.simpleTableQuery.primaryResults[0].data[0],
          ],
          _rows: [
            queryExecutionResponses.simpleTableQuery.primaryResults[0]._rows[0],
          ],
        },
      ],
    };

    (mockConnection.executeQuery as jest.Mock).mockResolvedValue(
      singleRowResponse,
    );

    // Act: Call the function under test
    const result = await executeQuery(mockConnection, 'SalesFact | take 1');

    // Assert: Verify column types are preserved
    expect(result).toBeDefined();
    expect(result.primaryResults).toBeDefined();
    expect(result.primaryResults.length).toBeGreaterThan(0);

    const primaryResult = result.primaryResults[0];
    expect(primaryResult.data.length).toBe(1);

    const row = primaryResult.data[0];

    // Verify that we have some data and it's properly typed
    expect(Object.keys(row).length).toBeGreaterThan(0);

    // Verify specific type preservation from our mock data
    if (row.SalesAmount !== undefined) {
      expect(typeof row.SalesAmount).toBe('number');
    }
    if (row.ProductKey !== undefined) {
      expect(typeof row.ProductKey).toBe('number');
    }
    if (row.DateKey !== undefined) {
      expect(typeof row.DateKey).toBe('string');
    }

    // Verify the executeQuery was called with correct parameters
    expect(mockConnection.executeQuery).toHaveBeenCalledWith(
      'ContosoSales',
      'SalesFact | take 1',
    );
  });

  test('should handle connection not initialized', async () => {
    // Arrange: Mock connection as not initialized
    (mockConnection.isInitialized as jest.Mock).mockReturnValue(false);

    // Act & Assert: Expect the function to throw an error
    await expect(
      executeQuery(mockConnection, 'SalesFact | take 5'),
    ).rejects.toThrow('Connection not initialized');

    // Verify executeQuery was not called on the connection
    expect(mockConnection.executeQuery).not.toHaveBeenCalled();
  });

  test('should work with showTables function integration', async () => {
    // Arrange: Mock the showTables function response
    (mockConnection.executeQuery as jest.Mock).mockResolvedValue(
      tablesListResponse,
    );

    // Act: Call showTables function (which internally uses executeQuery)
    const tables = await showTables(mockConnection);

    // Assert: Verify the tables result
    expect(tables).toBeDefined();
    expect(Array.isArray(tables)).toBe(true);
    expect(tables.length).toBeGreaterThan(0);

    // Verify table structure
    tables.forEach(table => {
      expect(table).toHaveProperty('TableName');
      expect(table).toHaveProperty('DatabaseName');
      expect(typeof table.TableName).toBe('string');
      expect(typeof table.DatabaseName).toBe('string');
    });

    // Verify specific tables exist
    const tableNames = tables.map(table => table.TableName);
    expect(tableNames).toContain('SalesFact');
    expect(tableNames).toContain('Products');

    // Verify the underlying executeQuery was called correctly
    expect(mockConnection.executeQuery).toHaveBeenCalledWith(
      'ContosoSales',
      '.show tables',
    );
  });
});
