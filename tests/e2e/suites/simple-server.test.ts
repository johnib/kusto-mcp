import { MCPTestClient } from '../helpers/mcp-test-client.js';

describe('Simple Server Test', () => {
  let client: MCPTestClient;

  afterEach(async () => {
    if (client) {
      await client.stopServer();
    }
  });

  test('should start MCP server successfully', async () => {
    client = new MCPTestClient();

    // Start the server
    await client.startServer();

    // Check if it's connected
    expect(client.isConnected()).toBe(true);
  }, 30000); // 30 second timeout for this test specifically
});
