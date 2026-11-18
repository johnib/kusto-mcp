/**
 * Regression guard for #291: `arguments` is optional in the MCP CallTool
 * request. A client that omits it must still be able to call the tools that
 * take no parameters; tools with required fields still reject the call.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createKustoServer } from '../../../src/server.js';
import { KustoConnection } from '../../../src/operations/kusto/index.js';

jest.mock('../../../src/common/version.js', () => ({ VERSION: '0.0.0-test' }));

jest.mock('../../../src/operations/kusto/index.js', () => {
  const actual = jest.requireActual('../../../src/operations/kusto/index.js');
  return {
    ...actual,
    KustoConnection: jest.fn(),
    showTables: jest.fn(async () => ({ tables: ['T1'] })),
  };
});

// server.ts imports showFunctions from tables.js directly.
jest.mock('../../../src/operations/kusto/tables.js', () => ({
  ...jest.requireActual('../../../src/operations/kusto/tables.js'),
  showFunctions: jest.fn(async () => ({ functions: ['F1'] })),
}));

const MockConnection = KustoConnection as unknown as jest.Mock;

beforeEach(() => {
  MockConnection.mockReset();
  MockConnection.mockImplementation(() => ({
    initialize: async (cluster: string, database: string) => ({
      cluster,
      database,
    }),
  }));
});

const text = (r: unknown) =>
  (r as { content: { text: string }[] }).content[0].text;

async function connected() {
  const server = createKustoServer({});
  const client = new Client({ name: 'unit-test', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const init = await client.callTool({
    name: 'initialize-connection',
    arguments: {
      cluster_url: 'https://help.kusto.windows.net',
      database: 'Samples',
    },
  });
  expect(init.isError).toBeFalsy();
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe('tool calls without "arguments" (#291)', () => {
  test.each([
    ['show-tables', 'T1'],
    ['show-functions', 'F1'],
  ])('%s works when the client omits arguments', async (name, expected) => {
    const { client, close } = await connected();
    try {
      const r = await client.callTool({ name });
      expect(r.isError).toBeFalsy();
      expect(text(r)).toContain(expected);
    } finally {
      await close();
    }
  });

  test.each(['show-tables', 'show-functions'])(
    '%s still works with an empty arguments object',
    async name => {
      const { client, close } = await connected();
      try {
        const r = await client.callTool({ name, arguments: {} });
        expect(r.isError).toBeFalsy();
      } finally {
        await close();
      }
    },
  );

  test.each([
    'execute-query',
    'show-table',
    'show-function',
    'initialize-connection',
  ])('%s without arguments still returns an error', async name => {
    const { client, close } = await connected();
    try {
      const r = await client.callTool({ name });
      expect(r.isError).toBe(true);
    } finally {
      await close();
    }
  });
});
