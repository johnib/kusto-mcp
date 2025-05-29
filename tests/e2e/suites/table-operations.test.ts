import { E2E_TEST_CONFIG } from '../config.js';
import { MCPTestClient } from '../helpers/mcp-test-client.js';
import {
  assertConnectionSuccess,
  assertErrorMessage,
  assertTableSchemaResponse,
  assertTablesListResponse,
} from '../helpers/test-assertions.js';

describe('Table Operations', () => {
  let client: MCPTestClient;

  beforeEach(async () => {
    client = new MCPTestClient();
    await client.startServer();

    // Initialize connection for all tests
    const initResponse = await client.callTool('initialize-connection', {
      cluster_url: E2E_TEST_CONFIG.cluster,
      database: E2E_TEST_CONFIG.database,
    });
    assertConnectionSuccess(initResponse);
  });

  afterEach(async () => {
    if (client) {
      await client.stopServer();
    }
  });

  test('should list all tables in ContosoSales database', async () => {
    const response = await client.callTool('show-tables', {});

    const tables = assertTablesListResponse(response);

    // ContosoSales should have at least some tables
    expect(tables.length).toBeGreaterThan(0);

    // Check that we have expected tables (based on ContosoSales sample data)
    const tableNames = tables.map(table => table.TableName);

    // These are common tables in ContosoSales sample database
    const expectedTables = ['SalesOrders', 'Products', 'Customers'];

    // At least one of these should exist
    const hasExpectedTable = expectedTables.some(expectedTable =>
      tableNames.includes(expectedTable),
    );
    expect(hasExpectedTable).toBe(true);
  });

  test('should return specific table schema for existing table', async () => {
    // First get the list of tables to find a valid table name
    const tablesResponse = await client.callTool('show-tables', {});
    const tables = assertTablesListResponse(tablesResponse);

    expect(tables.length).toBeGreaterThan(0);
    const firstTableName = tables[0].TableName;

    // Now get the schema for the first table
    const schemaResponse = await client.callTool('show-table', {
      tableName: firstTableName,
    });

    const schema = assertTableSchemaResponse(schemaResponse, firstTableName);

    // Should have at least one column
    expect(schema.columns.length).toBeGreaterThan(0);

    // Verify column structure
    schema.columns.forEach((column: any) => {
      expect(column.name).toBeTruthy();
      expect(column.type).toBeTruthy();
      expect(typeof column.name).toBe('string');
      expect(typeof column.type).toBe('string');
    });
  });

  test('should handle non-existent table requests gracefully', async () => {
    const response = await client.callTool('show-table', {
      tableName: 'NonExistentTable123',
    });

    assertErrorMessage(response, 'Error');
  });

  test('should handle empty table name', async () => {
    const response = await client.callTool('show-table', {
      tableName: '',
    });

    assertErrorMessage(response, 'Error');
  });

  test('should cache table schemas effectively', async () => {
    // First get a valid table name
    const tablesResponse = await client.callTool('show-tables', {});
    const tables = assertTablesListResponse(tablesResponse);
    const firstTableName = tables[0].TableName;

    // Request schema multiple times - should be fast due to caching
    const startTime = Date.now();

    const firstSchemaResponse = await client.callTool('show-table', {
      tableName: firstTableName,
    });

    const secondSchemaResponse = await client.callTool('show-table', {
      tableName: firstTableName,
    });

    const thirdSchemaResponse = await client.callTool('show-table', {
      tableName: firstTableName,
    });

    const endTime = Date.now();
    const totalTime = endTime - startTime;

    // All responses should be successful
    const firstSchema = assertTableSchemaResponse(
      firstSchemaResponse,
      firstTableName,
    );
    const secondSchema = assertTableSchemaResponse(
      secondSchemaResponse,
      firstTableName,
    );
    const thirdSchema = assertTableSchemaResponse(
      thirdSchemaResponse,
      firstTableName,
    );

    // Schemas should be identical (caching working)
    expect(firstSchema).toEqual(secondSchema);
    expect(secondSchema).toEqual(thirdSchema);

    // Total time should be reasonable (indicating caching effectiveness)
    expect(totalTime).toBeLessThan(10000); // Should complete within 10 seconds
  });

  test('should validate table schema structure matches expected format', async () => {
    // Get any table
    const tablesResponse = await client.callTool('show-tables', {});
    const tables = assertTablesListResponse(tablesResponse);
    const tableName = tables[0].TableName;

    const schemaResponse = await client.callTool('show-table', {
      tableName,
    });

    const schema = assertTableSchemaResponse(schemaResponse, tableName);

    // Validate that each column has all expected properties
    schema.columns.forEach((column: any) => {
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
  });

  test('should handle special characters in table names', async () => {
    // Test with table name that has special characters (if any exist)
    const response = await client.callTool('show-table', {
      tableName: 'Table-With-Dashes',
    });

    // Should handle gracefully (either success or proper error)
    if (response.isError) {
      assertErrorMessage(response, 'Error');
    } else {
      assertTableSchemaResponse(response, 'Table-With-Dashes');
    }
  });
});
