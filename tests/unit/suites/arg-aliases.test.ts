/**
 * #432 — agents send `table`/`table_name` to show-table, `function`/
 * `function_name` to show-function and `cluster`/`clusterUrl` to
 * initialize-connection. The server maps each alias to the canonical key
 * (only when the canonical key is absent), records a bounded boolean span
 * attribute, and still advertises only the canonical names.
 *
 * Drives the real tool-call handler; only the azure-kusto-data Client
 * (mocked in setup.ts) is routed.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { Client as KustoClient } from 'azure-kusto-data';
import { KustoConnection } from '../../../src/operations/kusto/connection.js';
import { createKustoServer } from '../../../src/server.js';
import { AuthenticationMethod } from '../../../src/types/config.js';

jest.mock('../../../src/common/version.js', () => ({ VERSION: '0.0.0-test' }));

const spans = new InMemorySpanExporter();
const tracerProvider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(spans)],
});

const ok = { primaryResults: [{ name: 'r', columns: [], _rows: [] }] };

/** Record every query the mocked Kusto client receives. */
function routeKusto(): string[] {
  const calls: string[] = [];
  jest
    .spyOn(KustoClient.prototype, 'execute')
    .mockImplementation(async (_db: string | null, q: string) => {
      calls.push(q);
      return ok as never;
    });
  return calls;
}

async function start() {
  const server = createKustoServer({
    authMethod: AuthenticationMethod.AzureCli,
    queryTimeout: 5000,
  });
  const client = new Client({ name: 'unit-test', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function connect(client: Client) {
  const init = await client.callTool({
    name: 'initialize-connection',
    arguments: { cluster_url: 'https://x.kusto.windows.net', database: 'd' },
  });
  expect(init.isError).toBeFalsy();
}

const toolSpan = (tool: string) =>
  spans.getFinishedSpans().filter(s => s.name === `mcp.tool/${tool}`);

describe('tool argument aliases (#432)', () => {
  beforeAll(() => tracerProvider.register());
  beforeEach(() => spans.reset());
  afterEach(() => jest.restoreAllMocks());

  test.each(['table', 'table_name'])(
    'show-table accepts %s as tableName',
    async alias => {
      const calls = routeKusto();
      const { client, close } = await start();
      try {
        await connect(client);
        spans.reset();
        const r = await client.callTool({
          name: 'show-table',
          arguments: { [alias]: 'AliasTable' },
        });
        expect(r.isError).toBeFalsy();
        expect(calls.some(q => q.includes('AliasTable'))).toBe(true);
        const [s] = toolSpan('show-table');
        expect(s.attributes['kustomcp.tool.arg_alias_used']).toBe(true);
      } finally {
        await close();
      }
    },
  );

  test.each(['function', 'function_name'])(
    'show-function accepts %s as functionName',
    async alias => {
      const calls = routeKusto();
      const { client, close } = await start();
      try {
        await connect(client);
        spans.reset();
        const r = await client.callTool({
          name: 'show-function',
          arguments: { [alias]: 'AliasFn' },
        });
        // The mock has no such function, so the call fails as not found.
        // It got past argument parsing: the query reached Kusto.
        expect(JSON.stringify(r.content)).toMatch(/not found/);
        expect(calls.some(q => q.includes('AliasFn'))).toBe(true);
        const [s] = toolSpan('show-function');
        expect(s.attributes['kustomcp.tool.arg_alias_used']).toBe(true);
      } finally {
        await close();
      }
    },
  );

  test.each(['cluster', 'clusterUrl'])(
    'initialize-connection accepts %s as cluster_url',
    async alias => {
      routeKusto();
      const init = jest.spyOn(KustoConnection.prototype, 'initialize');
      const { client, close } = await start();
      try {
        const r = await client.callTool({
          name: 'initialize-connection',
          arguments: {
            [alias]: 'https://alias.kusto.windows.net',
            database: 'd',
          },
        });
        expect(r.isError).toBeFalsy();
        expect(init.mock.calls[0][0]).toBe('https://alias.kusto.windows.net');
        const [s] = toolSpan('initialize-connection');
        expect(s.attributes['kustomcp.tool.arg_alias_used']).toBe(true);
      } finally {
        await close();
      }
    },
  );

  test('canonical key wins over an alias; no alias flag', async () => {
    const calls = routeKusto();
    const { client, close } = await start();
    try {
      await connect(client);
      spans.reset();
      await client.callTool({
        name: 'show-table',
        arguments: { tableName: 'Canonical', table: 'Alias' },
      });
      expect(calls.some(q => q.includes('Canonical'))).toBe(true);
      expect(calls.some(q => q.includes('Alias'))).toBe(false);
      const [s] = toolSpan('show-table');
      expect(s.attributes['kustomcp.tool.arg_alias_used']).toBe(false);
    } finally {
      await close();
    }
  });

  test('a null canonical key is filled from an alias', async () => {
    const calls = routeKusto();
    const { client, close } = await start();
    try {
      await connect(client);
      const r = await client.callTool({
        name: 'show-table',
        arguments: { tableName: null, table_name: 'NullFilled' },
      });
      expect(r.isError).toBeFalsy();
      expect(calls.some(q => q.includes('NullFilled'))).toBe(true);
    } finally {
      await close();
    }
  });

  test('a missing argument with no alias is still rejected', async () => {
    routeKusto();
    const { client, close } = await start();
    try {
      await connect(client);
      const r = await client.callTool({
        name: 'show-table',
        arguments: { other: 'x' },
      });
      expect(r.isError).toBe(true);
    } finally {
      await close();
    }
  });

  test('advertised schemas show only canonical names', async () => {
    const { client, close } = await start();
    try {
      const { tools } = await client.listTools();
      const props = (name: string) =>
        Object.keys(
          (tools.find(t => t.name === name)?.inputSchema.properties ??
            {}) as Record<string, unknown>,
        );
      expect(props('show-table')).toEqual(['tableName']);
      expect(props('show-function')).toEqual(['functionName']);
      expect(props('initialize-connection')).toEqual([
        'cluster_url',
        'database',
      ]);
    } finally {
      await close();
    }
  });
});
