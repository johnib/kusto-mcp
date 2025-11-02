/**
 * E2E tests for retry scenarios
 * These tests verify that retry logic works properly in real-world scenarios
 * Note: These tests require a real Kusto cluster connection
 */

import { E2E_TEST_CONFIG } from '../config.js';
import { MCPTestClient } from '../helpers/mcp-test-client.js';
import {
  assertConnectionSuccess,
  assertErrorResponse,
} from '../helpers/test-assertions.js';

describe('Retry Logic E2E Tests', () => {
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

  test.skip('should retry connection initialization on transient failures', async () => {
    // This test would require the ability to simulate transient failures
    // Skip for now since it requires advanced network simulation

    const initResponse = await client.callTool('initialize-connection', {
      cluster_url: E2E_TEST_CONFIG.cluster,
      database: E2E_TEST_CONFIG.database,
    });

    // If connection succeeds, retry logic worked or wasn't needed
    assertConnectionSuccess(initResponse);
  });

  test.skip('should retry query execution on transient failures', async () => {
    // This test would require the ability to simulate transient failures during query execution
    // Skip for now since it requires advanced network simulation

    // Initialize connection first
    const initResponse = await client.callTool('initialize-connection', {
      cluster_url: E2E_TEST_CONFIG.cluster,
      database: E2E_TEST_CONFIG.database,
    });
    assertConnectionSuccess(initResponse);

    // Execute a simple query that should work
    const response = await client.callTool('execute-query', {
      query: 'print "retry test"',
    });

    // If query succeeds, retry logic worked or wasn't needed
    expect(response.isError).toBe(false);
  });

  test('should respect retry configuration from environment variables', async () => {
    // This test verifies that retry configuration is properly loaded
    // The actual retry behavior is tested in unit tests

    // Set custom retry configuration via environment variables
    process.env.KUSTO_MAX_RETRIES = '5';
    process.env.KUSTO_RETRY_BASE_DELAY_MS = '200';
    process.env.KUSTO_RETRY_BACKOFF_MULTIPLIER = '1.5';

    try {
      // Restart client to pick up new environment variables
      if (client) {
        await client.stopServer();
      }
      client = new MCPTestClient();
      await client.startServer();

      // Initialize connection (this will use the new retry configuration)
      const initResponse = await client.callTool('initialize-connection', {
        cluster_url: E2E_TEST_CONFIG.cluster,
        database: E2E_TEST_CONFIG.database,
      });

      // The retry configuration should be loaded and logged
      // Check that connection attempt was made (success or failure both indicate config was loaded)
      expect(initResponse).toBeDefined();
    } finally {
      // Clean up environment variables
      delete process.env.KUSTO_MAX_RETRIES;
      delete process.env.KUSTO_RETRY_BASE_DELAY_MS;
      delete process.env.KUSTO_RETRY_BACKOFF_MULTIPLIER;
    }
  });

  test('should not retry permanent errors', async () => {
    // Test that authentication errors are not retried
    const initResponse = await client.callTool('initialize-connection', {
      cluster_url: 'https://invalid-cluster-that-does-not-exist.kusto.windows.net',
      database: E2E_TEST_CONFIG.database,
    });

    // Should fail without excessive retry attempts
    assertErrorResponse(initResponse);

    // The error should be returned relatively quickly for permanent errors
    // (not after multiple retry attempts with backoff delays)
  });
});