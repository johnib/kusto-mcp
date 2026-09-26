/**
 * Regression guard: the server must start with prompts disabled.
 *
 * The MCP SDK refuses to register a prompts/* request handler unless the
 * server declares the `prompts` capability, so registering the prompt handlers
 * unconditionally made `createKustoServer({ enablePrompts: false })` throw
 * "Server does not support prompts (required for prompts/list)" at startup.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createKustoServer } from '../../../src/server.js';
import { KustoConfig } from '../../../src/types/config.js';

// version.ts reads package.json via `import.meta`, which ts-jest cannot compile
// in this project's CJS test transform.
jest.mock('../../../src/common/version.js', () => ({ VERSION: '0.0.0-test' }));

// No clusterUrl/defaultDatabase, so createKustoServer skips auto-connect.
const baseConfig: KustoConfig = {};

async function connectClient(config: KustoConfig) {
  const server = createKustoServer(config);
  const client = new Client({ name: 'unit-test', version: '0.0.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe('createKustoServer prompts capability', () => {
  test('does not throw when prompts are disabled', () => {
    expect(() =>
      createKustoServer({ ...baseConfig, enablePrompts: false }),
    ).not.toThrow();
  });

  test('prompts disabled: no prompts capability, tools still list', async () => {
    const { client, close } = await connectClient({
      ...baseConfig,
      enablePrompts: false,
    });
    try {
      const capabilities = client.getServerCapabilities();
      expect(capabilities?.prompts).toBeUndefined();
      expect(capabilities?.tools).toBeDefined();

      const { tools } = await client.listTools();
      expect(tools.map(t => t.name)).toContain('execute-query');
    } finally {
      await close();
    }
  });

  test('prompts enabled: prompts capability advertised and prompts/list works', async () => {
    const { client, close } = await connectClient({
      ...baseConfig,
      enablePrompts: true,
    });
    try {
      const capabilities = client.getServerCapabilities();
      expect(capabilities?.prompts).toBeDefined();
      expect(capabilities?.tools).toBeDefined();

      const { prompts } = await client.listPrompts();
      expect(prompts.length).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });
});
