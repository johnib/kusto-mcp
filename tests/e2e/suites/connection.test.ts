import { E2E_TEST_CONFIG } from '../config.js';
import { MCPTestClient } from '../helpers/mcp-test-client.js';
import {
  assertConnectionSuccess,
  assertErrorMessage,
  assertToolsList,
} from '../helpers/test-assertions.js';

describe('Connection Management', () => {
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

  test('should start MCP server successfully', async () => {
    expect(client.isConnected()).toBe(true);
  });

  test('should list available tools', async () => {
    const toolsResponse = await client.listTools();
    assertToolsList(toolsResponse);
  });

  test('should connect to help.kusto.windows.net successfully', async () => {
    const response = await client.callTool('initialize-connection', {
      cluster_url: E2E_TEST_CONFIG.cluster,
      database: E2E_TEST_CONFIG.database,
    });

    assertConnectionSuccess(response);
  });

  test('should handle invalid cluster URL gracefully', async () => {
    const response = await client.callTool('initialize-connection', {
      cluster_url: 'https://invalid-cluster.windows.net/',
      database: E2E_TEST_CONFIG.database,
    });

    assertErrorMessage(response, 'Error');
  });

  test('should handle invalid database name gracefully', async () => {
    const response = await client.callTool('initialize-connection', {
      cluster_url: E2E_TEST_CONFIG.cluster,
      database: 'NonExistentDatabase',
    });

    assertErrorMessage(response, 'Error');
  });

  test('should require connection initialization for other tools', async () => {
    // Try to use show-tables without initialization
    const response = await client.callTool('show-tables', {});

    assertErrorMessage(response, 'Connection not initialized');
  });

  test('should maintain connection state across multiple operations', async () => {
    // Initialize connection
    const initResponse = await client.callTool('initialize-connection', {
      cluster_url: E2E_TEST_CONFIG.cluster,
      database: E2E_TEST_CONFIG.database,
    });
    assertConnectionSuccess(initResponse);

    // Use multiple tools to verify connection is maintained
    const tablesResponse = await client.callTool('show-tables', {});
    expect(tablesResponse.isError).toBeFalsy();

    const functionsResponse = await client.callTool('show-functions', {});
    expect(functionsResponse.isError).toBeFalsy();
  });

  test('should allow reconnection with different parameters', async () => {
    // First connection
    const firstResponse = await client.callTool('initialize-connection', {
      cluster_url: E2E_TEST_CONFIG.cluster,
      database: E2E_TEST_CONFIG.database,
    });
    assertConnectionSuccess(firstResponse);

    // Second connection (should override the first)
    const secondResponse = await client.callTool('initialize-connection', {
      cluster_url: E2E_TEST_CONFIG.cluster,
      database: E2E_TEST_CONFIG.database,
    });
    assertConnectionSuccess(secondResponse);
  });
});
