import { E2E_TEST_CONFIG } from '../config.js';
import { MCPTestClient } from '../helpers/mcp-test-client.js';
import {
  assertConnectionSuccess,
  assertErrorMessage,
  assertErrorResponse,
} from '../helpers/test-assertions.js';

describe('Error Handling', () => {
  let client: MCPTestClient;

  beforeEach(async () => {
    client = new MCPTestClient();
    await client.startServer();
  });

  afterEach(async () => {
    if (client) {
      await client.stopServer();
    }
  });

  test('should handle invalid KQL syntax gracefully', async () => {
    // Initialize connection first
    const initResponse = await client.callTool('initialize-connection', {
      cluster_url: E2E_TEST_CONFIG.cluster,
      database: E2E_TEST_CONFIG.database,
    });
    assertConnectionSuccess(initResponse);

    // Test with invalid KQL syntax
    const response = await client.callTool('execute-query', {
      query: 'invalid_syntax_here | this_is_not_kql',
    });

    assertErrorResponse(response);
    assertErrorMessage(response, 'Error');
  });

  test('should handle queries to non-existent tables', async () => {
    // Initialize connection first
    const initResponse = await client.callTool('initialize-connection', {
      cluster_url: E2E_TEST_CONFIG.cluster,
      database: E2E_TEST_CONFIG.database,
    });
    assertConnectionSuccess(initResponse);

    // Test with non-existent table
    const response = await client.callTool('execute-query', {
      query: 'NonExistentTable123 | take 1',
    });

    assertErrorResponse(response);
    assertErrorMessage(response, 'Error');
  });

  test('should handle authentication failures', async () => {
    // Test with invalid cluster URL (should cause auth issues)
    const response = await client.callTool('initialize-connection', {
      cluster_url: 'https://invalid-cluster-12345.windows.net/',
      database: E2E_TEST_CONFIG.database,
    });

    assertErrorResponse(response);
    assertErrorMessage(response, 'Error');
  });

  test('should handle network timeouts gracefully', async () => {
    // Initialize connection first
    const initResponse = await client.callTool('initialize-connection', {
      cluster_url: E2E_TEST_CONFIG.cluster,
      database: E2E_TEST_CONFIG.database,
    });
    assertConnectionSuccess(initResponse);

    // Test with a potentially long-running query
    // This might timeout based on server configuration
    const response = await client.callTool('execute-query', {
      query: `
        range i from 1 to 1000000 step 1
        | extend data = strcat("row", i)
        | summarize count() by data
        | take 1000000
      `,
      limit: 1000,
    });

    // Should either succeed or fail gracefully with timeout
    if (response.isError) {
      assertErrorMessage(response, 'Error');
    } else {
      // If it succeeds, verify the response structure
      expect(response.content).toBeDefined();
      expect(response.content[0]).toHaveProperty('text');
    }
  });

  test('should handle malformed JSON-RPC requests', async () => {
    // This test verifies that the MCP client handles protocol errors
    // We'll test by sending invalid tool parameters

    const response = await client.callTool('initialize-connection', {
      // Missing required parameters
    });

    assertErrorResponse(response);
    assertErrorMessage(response, 'Error');
  });

  test('should handle missing tool parameters', async () => {
    // Initialize connection first
    const initResponse = await client.callTool('initialize-connection', {
      cluster_url: E2E_TEST_CONFIG.cluster,
      database: E2E_TEST_CONFIG.database,
    });
    assertConnectionSuccess(initResponse);

    // Test show-table without tableName parameter
    const response = await client.callTool('show-table', {
      // Missing tableName parameter
    });

    assertErrorResponse(response);
    assertErrorMessage(response, 'Error');
  });

  test('should handle invalid tool parameters', async () => {
    // Initialize connection first
    const initResponse = await client.callTool('initialize-connection', {
      cluster_url: E2E_TEST_CONFIG.cluster,
      database: E2E_TEST_CONFIG.database,
    });
    assertConnectionSuccess(initResponse);

    // Test with invalid parameter types
    const response = await client.callTool('execute-query', {
      query: 'SalesOrders | take 5',
      limit: 'invalid_number', // Should be a number
    });

    assertErrorResponse(response);
    assertErrorMessage(response, 'Error');
  });

  test('should handle unknown tool calls', async () => {
    // Test calling a non-existent tool
    const response = await client.callTool('non-existent-tool', {
      parameter: 'value',
    });

    assertErrorResponse(response);
    assertErrorMessage(response, 'Unknown tool');
  });

  test('should handle database connection loss', async () => {
    // Initialize connection first
    const initResponse = await client.callTool('initialize-connection', {
      cluster_url: E2E_TEST_CONFIG.cluster,
      database: E2E_TEST_CONFIG.database,
    });
    assertConnectionSuccess(initResponse);

    // Test with invalid database after successful initial connection
    const reconnectResponse = await client.callTool('initialize-connection', {
      cluster_url: E2E_TEST_CONFIG.cluster,
      database: 'NonExistentDatabase123',
    });

    assertErrorResponse(reconnectResponse);
    assertErrorMessage(reconnectResponse, 'Error');
  });

  test('should handle large result sets appropriately', async () => {
    // Initialize connection first
    const initResponse = await client.callTool('initialize-connection', {
      cluster_url: E2E_TEST_CONFIG.cluster,
      database: E2E_TEST_CONFIG.database,
    });
    assertConnectionSuccess(initResponse);

    // Test with query that might return large results but with small limit
    const response = await client.callTool('execute-query', {
      query: `
        range i from 1 to 100000 step 1
        | extend data = strcat("large_data_", i, "_", rand())
      `,
      limit: 2, // Very small limit
    });

    // Should handle gracefully by limiting results
    if (response.isError) {
      assertErrorMessage(response, 'Error');
    } else {
      // Should respect the limit
      const jsonText = response.content[0].text;
      const result = JSON.parse(jsonText);
      expect(result.data.length).toBeLessThanOrEqual(2);
      expect(result.metadata.isPartial).toBe(true);
    }
  });

  test('should handle queries with syntax errors in functions', async () => {
    // Initialize connection first
    const initResponse = await client.callTool('initialize-connection', {
      cluster_url: E2E_TEST_CONFIG.cluster,
      database: E2E_TEST_CONFIG.database,
    });
    assertConnectionSuccess(initResponse);

    // Test with invalid function syntax
    const response = await client.callTool('execute-query', {
      query: 'SalesOrders | extend invalid_function()',
    });

    assertErrorResponse(response);
    assertErrorMessage(response, 'Error');
  });

  test('should handle empty queries', async () => {
    // Initialize connection first
    const initResponse = await client.callTool('initialize-connection', {
      cluster_url: E2E_TEST_CONFIG.cluster,
      database: E2E_TEST_CONFIG.database,
    });
    assertConnectionSuccess(initResponse);

    // Test with empty query
    const response = await client.callTool('execute-query', {
      query: '',
    });

    assertErrorResponse(response);
    assertErrorMessage(response, 'Error');
  });

  test('should handle whitespace-only queries', async () => {
    // Initialize connection first
    const initResponse = await client.callTool('initialize-connection', {
      cluster_url: E2E_TEST_CONFIG.cluster,
      database: E2E_TEST_CONFIG.database,
    });
    assertConnectionSuccess(initResponse);

    // Test with whitespace-only query
    const response = await client.callTool('execute-query', {
      query: '   \n\t   ',
    });

    assertErrorResponse(response);
    assertErrorMessage(response, 'Error');
  });

  test('should provide meaningful error messages', async () => {
    // Initialize connection first
    const initResponse = await client.callTool('initialize-connection', {
      cluster_url: E2E_TEST_CONFIG.cluster,
      database: E2E_TEST_CONFIG.database,
    });
    assertConnectionSuccess(initResponse);

    // Test various error scenarios and verify error messages are helpful
    const testCases = [
      {
        query: 'NonExistentTable | take 1',
        description: 'non-existent table',
      },
      {
        query: 'SalesOrders | invalid_operator',
        description: 'invalid operator',
      },
      {
        query: 'SalesOrders | where',
        description: 'incomplete where clause',
      },
    ];

    for (const testCase of testCases) {
      const response = await client.callTool('execute-query', {
        query: testCase.query,
      });

      assertErrorResponse(response);

      const errorText = response.content[0].text;

      // Error message should be non-empty and descriptive
      expect(errorText.length).toBeGreaterThan(10);
      expect(errorText).toContain('Error');

      // Should not expose internal details but should be helpful
      expect(errorText).not.toContain('stack trace');
      expect(errorText).not.toContain('internal error');
    }
  });
});
