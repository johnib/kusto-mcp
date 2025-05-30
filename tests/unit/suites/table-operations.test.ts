import { KustoConnection } from '../../../src/operations/kusto/connection.js';
import { showTable, showTables } from '../../../src/operations/kusto/tables.js';
import {
  emptyTableNameError,
  nonExistentTableError,
  showTableSchemaProcessedResponse,
  showTablesProcessedResponse,
} from '../fixtures/table-operations-responses.js';

// Create mock connection factory
const createMockConnection = () => {
  const mockConnection = {
    isInitialized: jest.fn().mockReturnValue(true),
    getDatabase: jest.fn().mockReturnValue('ContosoSales'),
    executeQuery: jest.fn(),
  } as unknown as KustoConnection;

  return mockConnection;
};

describe('Table Operations', () => {
  let mockConnection: KustoConnection;

  beforeEach(() => {
    mockConnection = createMockConnection();
  });

  test('should list all tables in ContosoSales database', async () => {
    // Arrange: Mock the executeQuery response for .show tables
    (mockConnection.executeQuery as jest.Mock).mockResolvedValue(
      showTablesProcessedResponse,
    );

    // Act: Call the function under test
    const tables = await showTables(mockConnection);

    // Assert: Verify the behavior
    expect(tables.length).toBeGreaterThan(0);
    expect(tables.length).toBe(13); // ContosoSales has 13 tables

    // Check that we have expected tables (based on ContosoSales sample data)
    const tableNames = tables.map(table => table.TableName);
    const expectedTables = ['SalesFact', 'Products', 'Customers'];

    // At least one of these should exist
    const hasExpectedTable = expectedTables.some(expectedTable =>
      tableNames.includes(expectedTable),
    );
    expect(hasExpectedTable).toBe(true);

    // Verify specific tables exist
    expect(tableNames).toContain('SalesFact');
    expect(tableNames).toContain('Products');
    expect(tableNames).toContain('Customers');

    // Verify the executeQuery was called with correct parameters
    expect(mockConnection.executeQuery).toHaveBeenCalledWith(
      'ContosoSales',
      '.show tables',
    );
  });

  test('should return specific table schema for existing table', async () => {
    // Arrange: Mock the executeQuery responses for both .show tables and table schema
    (mockConnection.executeQuery as jest.Mock)
      .mockResolvedValueOnce(showTablesProcessedResponse) // First call for show tables
      .mockResolvedValueOnce(showTableSchemaProcessedResponse); // Second call for table schema

    // Act: First get the list of tables to find a valid table name
    const tables = await showTables(mockConnection);
    expect(tables.length).toBeGreaterThan(0);
    const firstTableName = tables[0].TableName;
    expect(firstTableName).toBe('SalesFact');

    // Now get the schema for the first table
    const schema = await showTable(mockConnection, firstTableName);

    // Assert: Verify the schema structure
    expect(schema.tableName).toBe('SalesFact');
    expect(schema.databaseName).toBe('ContosoSales');
    expect(schema.columns.length).toBeGreaterThan(0);
    expect(schema.columns.length).toBe(5); // SalesFact has 5 columns

    // Verify column structure
    schema.columns.forEach(column => {
      expect(column.name).toBeTruthy();
      expect(column.type).toBeTruthy();
      expect(typeof column.name).toBe('string');
      expect(typeof column.type).toBe('string');
    });

    // Verify specific columns exist
    const columnNames = schema.columns.map(col => col.name);
    expect(columnNames).toContain('SalesAmount');
    expect(columnNames).toContain('TotalCost');
    expect(columnNames).toContain('DateKey');
    expect(columnNames).toContain('ProductKey');
    expect(columnNames).toContain('CustomerKey');

    // Verify the executeQuery was called with correct parameters
    expect(mockConnection.executeQuery).toHaveBeenCalledWith(
      'ContosoSales',
      'SalesFact | getschema',
    );
  });

  test('should handle non-existent table requests gracefully', async () => {
    // Arrange: Mock the executeQuery to throw an error for non-existent table
    (mockConnection.executeQuery as jest.Mock).mockRejectedValue(
      nonExistentTableError,
    );

    // Act & Assert: Expect the function to throw an error
    await expect(
      showTable(mockConnection, 'NonExistentTable123'),
    ).rejects.toThrow(
      'Query error: Failed to get table schema: Query error: Failed to execute query: Request failed with status code 400',
    );

    // Verify the executeQuery was called with correct parameters
    expect(mockConnection.executeQuery).toHaveBeenCalledWith(
      'ContosoSales',
      'NonExistentTable123 | getschema',
    );
  });

  test('should handle empty table name', async () => {
    // Arrange: Mock the executeQuery to throw an error for empty table name
    (mockConnection.executeQuery as jest.Mock).mockRejectedValue(
      emptyTableNameError,
    );

    // Act & Assert: Expect the function to throw an error
    await expect(showTable(mockConnection, '')).rejects.toThrow(
      'Query error: Failed to get table schema: Query error: Failed to execute query: Request failed with status code 400',
    );

    // Verify the executeQuery was called with correct parameters
    expect(mockConnection.executeQuery).toHaveBeenCalledWith(
      'ContosoSales',
      ' | getschema',
    );
  });

  test('should validate table schema structure matches expected format', async () => {
    // Arrange: Mock the executeQuery responses
    (mockConnection.executeQuery as jest.Mock)
      .mockResolvedValueOnce(showTablesProcessedResponse)
      .mockResolvedValueOnce(showTableSchemaProcessedResponse);

    // Act: Get any table
    const tables = await showTables(mockConnection);
    const tableName = tables[0].TableName;

    const schema = await showTable(mockConnection, tableName);

    // Assert: Validate that each column has all expected properties
    schema.columns.forEach(column => {
      // Required properties
      expect(column).toHaveProperty('name');
      expect(column).toHaveProperty('type');

      // Column names should not be empty
      expect(column.name.trim()).toBeTruthy();
      expect(column.type.trim()).toBeTruthy();

      // Column types should be valid Kusto types
      const validTypes = [
        'bool',
        'boolean',
        'datetime',
        'date',
        'dynamic',
        'guid',
        'uuid',
        'int',
        'long',
        'real',
        'double',
        'decimal',
        'string',
        'timespan',
      ];

      const columnType = column.type.toLowerCase();
      const isValidType = validTypes.some(validType =>
        columnType.includes(validType),
      );

      expect(isValidType).toBe(true);
    });

    // Verify specific column types from our fixture
    const salesAmountColumn = schema.columns.find(
      col => col.name === 'SalesAmount',
    );
    expect(salesAmountColumn?.type).toBe('real');

    const dateKeyColumn = schema.columns.find(col => col.name === 'DateKey');
    expect(dateKeyColumn?.type).toBe('datetime');

    const productKeyColumn = schema.columns.find(
      col => col.name === 'ProductKey',
    );
    expect(productKeyColumn?.type).toBe('long');
  });

  test('should handle special characters in table names', async () => {
    // Arrange: Mock the executeQuery to throw an error for table with special characters
    (mockConnection.executeQuery as jest.Mock).mockRejectedValue(
      nonExistentTableError,
    );

    // Act & Assert: Should handle gracefully (either success or proper error)
    await expect(
      showTable(mockConnection, 'Table-With-Dashes'),
    ).rejects.toThrow(
      'Query error: Failed to get table schema: Query error: Failed to execute query: Request failed with status code 400',
    );

    // Verify the executeQuery was called with correct parameters
    expect(mockConnection.executeQuery).toHaveBeenCalledWith(
      'ContosoSales',
      'Table-With-Dashes | getschema',
    );
  });

  // Additional unit test specific validation
  test('should handle connection not initialized', async () => {
    // Arrange: Mock connection as not initialized
    (mockConnection.isInitialized as jest.Mock).mockReturnValue(false);

    // Act & Assert: Expect the function to throw an error
    await expect(showTables(mockConnection)).rejects.toThrow(
      'Connection not initialized',
    );

    // Verify executeQuery was not called
    expect(mockConnection.executeQuery).not.toHaveBeenCalled();
  });

  test('should handle missing primary results in show tables response', async () => {
    // Arrange: Mock response with no primary results
    (mockConnection.executeQuery as jest.Mock).mockResolvedValue({
      primaryResults: [],
      tables: [],
    });

    // Act & Assert: Expect the function to throw an error
    await expect(showTables(mockConnection)).rejects.toThrow(
      'No primary result found in show tables response',
    );
  });

  test('should handle missing primary results in show table response', async () => {
    // Arrange: Mock response with no primary results
    (mockConnection.executeQuery as jest.Mock).mockResolvedValue({
      primaryResults: [],
      tables: [],
    });

    // Act & Assert: Expect the function to throw an error
    await expect(showTable(mockConnection, 'SalesFact')).rejects.toThrow(
      'No primary result found in show table response',
    );
  });
});
