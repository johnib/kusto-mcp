/**
 * Regression guard for #314: the execute-query tool description must nudge
 * the agent to inspect an unfamiliar table with show-table before querying it.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createKustoServer } from '../../../src/server.js';

// version.ts reads package.json via `import.meta`, which ts-jest cannot compile
// in this project's CJS test transform.
jest.mock('../../../src/common/version.js', () => ({ VERSION: '0.0.0-test' }));

describe('execute-query tool description', () => {
  test('suggests calling show-table first for an uninspected table', async () => {
    // No clusterUrl/defaultDatabase, so createKustoServer skips auto-connect.
    const server = createKustoServer({});
    const client = new Client({ name: 'unit-test', version: '0.0.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      const { tools } = await client.listTools();
      const executeQuery = tools.find(t => t.name === 'execute-query');
      expect(executeQuery?.description).toMatch(/show-table/);
      // The rest of the description stays intact.
      expect(executeQuery?.description).toMatch(/^Runs KQL queries/);
      expect(executeQuery?.description).toMatch(/"purpose"/);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
