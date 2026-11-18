/**
 * Regression guard for #292: execute-query validates `limit` as a bounded
 * positive integer and appends a valid `| take <limit+1>` to the query.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createKustoServer } from '../../../src/server.js';
import { executeQuery } from '../../../src/operations/kusto/index.js';

jest.mock('../../../src/common/version.js', () => ({ VERSION: '0.0.0-test' }));

jest.mock('../../../src/operations/kusto/index.js', () => {
  const actual = jest.requireActual('../../../src/operations/kusto/index.js');
  return {
    ...actual,
    KustoConnection: jest.fn().mockImplementation(() => ({
      initialize: async () => ({ cluster: 'c', database: 'd' }),
    })),
    executeQuery: jest.fn(async () => ({
      primaryResults: [
        { name: 'r', columns: [{ ColumnName: 'a' }], _rows: [[1], [2]] },
      ],
    })),
  };
});

const mockedExecuteQuery = executeQuery as jest.Mock;

async function connect() {
  const server = createKustoServer({});
  const client = new Client({ name: 'unit-test', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  await client.callTool({
    name: 'initialize-connection',
    arguments: { cluster_url: 'https://x.kusto.windows.net', database: 'd' },
  });
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe('execute-query limit validation (#292)', () => {
  beforeEach(() => mockedExecuteQuery.mockClear());

  test.each([0, -1, -5, 2.5, 1e21])(
    'limit %p is rejected and no query runs',
    async limit => {
      const { client, close } = await connect();
      try {
        const res = await client.callTool({
          name: 'execute-query',
          arguments: { query: 'T', limit },
        });
        expect(res.isError).toBe(true);
        expect(mockedExecuteQuery).not.toHaveBeenCalled();
      } finally {
        await close();
      }
    },
  );

  test.each<[number | undefined, string]>([
    [undefined, 'T\n| take 21'],
    [1, 'T\n| take 2'],
    [10000, 'T\n| take 10001'],
    // Above the cap: clamped to 10000, not rejected. Real callers send these.
    [10001, 'T\n| take 10001'],
    [50000, 'T\n| take 10001'],
  ])('limit %p appends a valid take', async (limit, expected) => {
    const { client, close } = await connect();
    try {
      const res = await client.callTool({
        name: 'execute-query',
        arguments: limit === undefined ? { query: 'T' } : { query: 'T', limit },
      });
      expect(res.isError).toBeFalsy();
      expect(mockedExecuteQuery).toHaveBeenCalledTimes(1);
      expect(mockedExecuteQuery.mock.calls[0][1]).toBe(expected);
    } finally {
      await close();
    }
  });

  test('a trailing ";" does not reach Kusto before the take', async () => {
    const { client, close } = await connect();
    try {
      const res = await client.callTool({
        name: 'execute-query',
        arguments: { query: 'T | sort by x desc;\n', limit: 5 },
      });
      expect(res.isError).toBeFalsy();
      expect(mockedExecuteQuery.mock.calls[0][1]).toBe(
        'T | sort by x desc\n| take 6',
      );
    } finally {
      await close();
    }
  });

  test('the tool schema has no 10000 maximum that clients would enforce', async () => {
    const { client, close } = await connect();
    try {
      const { tools } = await client.listTools();
      const limit = (
        tools.find(t => t.name === 'execute-query')!.inputSchema as {
          properties: Record<string, Record<string, unknown>>;
        }
      ).properties.limit;
      expect(limit.type).toBe('integer');
      expect(limit.minimum).toBe(1);
      // zod's .int() adds only the safe-integer bound.
      expect([undefined, Number.MAX_SAFE_INTEGER]).toContain(limit.maximum);
    } finally {
      await close();
    }
  });
});
