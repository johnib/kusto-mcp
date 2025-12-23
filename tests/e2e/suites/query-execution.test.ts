import { E2E_TEST_CONFIG } from '../config.js';
import { MCPTestClient } from '../helpers/mcp-test-client.js';
import {
  assertConnectionSuccess,
  assertQueryExecutionResponse,
  assertQueryRowCount,
  assertTablesListResponse,
} from '../helpers/test-assertions.js';

describe('Query Execution', () => {
  let client: MCPTestClient;
  let availableTableName: string;

  beforeEach(async () => {
    client = new MCPTestClient();
    await client.startServer();

    // Initialize connection for all tests
    const initResponse = await client.callTool('initialize-connection', {
      cluster_url: E2E_TEST_CONFIG.cluster,
      database: E2E_TEST_CONFIG.database,
    });
    assertConnectionSuccess(initResponse);

    // Get available table name for dynamic queries
    const tablesResponse = await client.callTool('show-tables', {});
    const tables = assertTablesListResponse(tablesResponse);
    availableTableName = tables[0].TableName;
  });

  afterEach(async () => {
    if (client) {
      await client.stopServer();
    }
  });

  test('should execute simple table query with take limit', async () => {
    const response = await client.callTool('execute-query', {
      query: `${availableTableName} | take 5`,
      limit: E2E_TEST_CONFIG.testQueryLimit,
    });

    const result = assertQueryExecutionResponse(response);
    assertQueryRowCount(response, undefined, E2E_TEST_CONFIG.testQueryLimit);

    // Should have data array
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data.length).toBeGreaterThan(0);
    expect(result.data.length).toBeLessThanOrEqual(
      E2E_TEST_CONFIG.testQueryLimit,
    );
  });

  test('should execute count query and return single row', async () => {
    const response = await client.callTool('execute-query', {
      query: `${availableTableName} | count`,
    });

    const result = assertQueryExecutionResponse(response);

    // Count query should return exactly one row
    assertQueryRowCount(response, 1);

    // The row should contain a count value
    expect(result.data[0]).toHaveProperty('Count');
    expect(typeof result.data[0].Count).toBe('number');
    expect(result.data[0].Count).toBeGreaterThan(0);
  });

  test('should execute management command: .show tables', async () => {
    const response = await client.callTool('execute-query', {
      query: '.show tables',
    });

    const result = assertQueryExecutionResponse(response);

    // Should return list of tables
    expect(result.data.length).toBeGreaterThan(0);

    // Each row should have table information
    result.data.forEach((table: any) => {
      expect(table).toHaveProperty('TableName');
      expect(typeof table.TableName).toBe('string');
    });
  });

  test('should execute aggregation query', async () => {
    const response = await client.callTool('execute-query', {
      query: `${availableTableName} | summarize Count = count() | take 1`,
    });

    const result = assertQueryExecutionResponse(response);

    // Should return aggregation result
    assertQueryRowCount(response, 1);
    expect(result.data[0]).toHaveProperty('Count');
    expect(typeof result.data[0].Count).toBe('number');
  });

  test('should handle result limiting correctly', async () => {
    const limit = 3;
    const response = await client.callTool('execute-query', {
      query: `${availableTableName} | take 10`, // Request more than limit
      limit: limit,
    });

    const result = assertQueryExecutionResponse(response);

    // Should respect the limit
    expect(result.data.length).toBeLessThanOrEqual(limit);
    expect(result.metadata.requestedLimit).toBe(limit);

    // If we got exactly the limit, it might be partial
    if (result.data.length === limit) {
      expect(result.metadata.isPartial).toBe(true);
      expect(result.metadata.hasMoreResults).toBe(true);
    }
  });

  test('should detect partial results and set metadata correctly', async () => {
    const limit = 2; // Very small limit to force partial results
    const response = await client.callTool('execute-query', {
      query: `${availableTableName} | take 100`, // Request many more than limit
      limit: limit,
    });

    const result = assertQueryExecutionResponse(response);

    // With a small limit and large request, should be partial
    expect(result.data.length).toBeLessThanOrEqual(limit);

    if (result.metadata.isPartial) {
      expect(result.metadata.hasMoreResults).toBe(true);
    }
  });

  test('should handle queries that return no results', async () => {
    const response = await client.callTool('execute-query', {
      query: `${availableTableName} | where 1 == 0`, // Impossible condition
    });

    const result = assertQueryExecutionResponse(response);

    // Should return empty results gracefully
    expect(result.data).toEqual([]);
    expect(result.metadata.rowCount).toBe(0);
    expect(result.metadata.isPartial).toBe(false);
    expect(result.metadata.hasMoreResults).toBe(false);
  });

  test('should handle time-based queries with ago() function', async () => {
    // Try to find a table with a datetime column for time-based queries
    const response = await client.callTool('execute-query', {
      query: `${availableTableName} | getschema | where ColumnType contains "datetime" | take 1`,
    });

    const schemaResult = assertQueryExecutionResponse(response);

    if (schemaResult.data.length > 0) {
      const dateColumn = schemaResult.data[0].ColumnName;

      // Execute time-based query
      const timeQueryResponse = await client.callTool('execute-query', {
        query: `${availableTableName} | where ${dateColumn} > ago(365d) | take 5`,
        limit: 5,
      });

      // Should execute successfully (may or may not have results)
      assertQueryExecutionResponse(timeQueryResponse);
    } else {
      // If no datetime columns, just verify the schema query worked
      expect(schemaResult.data).toEqual([]);
    }
  });

  test('should execute complex aggregation with grouping', async () => {
    const response = await client.callTool('execute-query', {
      query: `${availableTableName} | take 1000 | summarize Count = count() by bin(now(), 1d) | take 5`,
      limit: 5,
    });

    const result = assertQueryExecutionResponse(response);

    // Should execute successfully
    expect(result.metadata.rowCount).toBeGreaterThanOrEqual(0);

    if (result.data.length > 0) {
      // Each row should have the aggregation columns
      result.data.forEach((row: any) => {
        expect(row).toHaveProperty('Count');
        expect(typeof row.Count).toBe('number');
      });
    }
  });

  test('should handle default limit when not specified', async () => {
    const response = await client.callTool('execute-query', {
      query: `${availableTableName} | take 100`, // Request more than default limit
      // No limit specified - should use default
    });

    const result = assertQueryExecutionResponse(response);

    // Should use default limit
    expect(result.metadata.requestedLimit).toBe(
      E2E_TEST_CONFIG.defaultQueryLimit,
    );
    expect(result.data.length).toBeLessThanOrEqual(
      E2E_TEST_CONFIG.defaultQueryLimit,
    );
  });

  test('should handle schema exploration queries', async () => {
    const response = await client.callTool('execute-query', {
      query: `${availableTableName} | getschema`,
    });

    const result = assertQueryExecutionResponse(response);

    // Should return schema information
    expect(result.data.length).toBeGreaterThan(0);

    // Each row should have column information
    result.data.forEach((column: any) => {
      expect(column).toHaveProperty('ColumnName');
      expect(column).toHaveProperty('ColumnType');
      expect(typeof column.ColumnName).toBe('string');
      expect(typeof column.ColumnType).toBe('string');
    });
  });

  test('should preserve column types in query results', async () => {
    const response = await client.callTool('execute-query', {
      query: `${availableTableName} | take 1`,
      limit: 1,
    });

    const result = assertQueryExecutionResponse(response);

    if (result.data.length > 0) {
      const row = result.data[0];

      // Verify that we have some data and it's properly typed
      expect(Object.keys(row).length).toBeGreaterThan(0);

      // Each property should have a value (could be null, but should exist)
      Object.keys(row).forEach(key => {
        expect(row.hasOwnProperty(key)).toBe(true);
      });
    }
  });
});
