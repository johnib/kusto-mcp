/**
 * #313: after several failed execute-query calls in a row, the error returned
 * to the agent carries one recovery hint line. A success resets the streak.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createKustoServer } from '../../../src/server.js';
import { SessionTracker } from '../../../src/common/session-tracker.js';
import { executeQuery } from '../../../src/operations/kusto/index.js';
import {
  KustoQueryCancelledError,
  KustoTimeoutError,
} from '../../../src/common/errors.js';

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
        { name: 'r', columns: [{ ColumnName: 'a' }], _rows: [[1]] },
      ],
    })),
  };
});

const HINT =
  'Several queries failed in a row – check the table schema with show-table and simplify the query.';

describe('SessionTracker consecutive query failures', () => {
  const run = (t: SessionTracker, status: string) =>
    t.beginQuery(20).finish({ status });

  test('counts errors in a row and resets on success', () => {
    const t = new SessionTracker();
    expect(t.consecutiveQueryFailures).toBe(0);
    run(t, 'error');
    run(t, 'error');
    expect(t.consecutiveQueryFailures).toBe(2);
    run(t, 'error');
    expect(t.consecutiveQueryFailures).toBe(3);
    run(t, 'ok');
    expect(t.consecutiveQueryFailures).toBe(0);
    run(t, 'error');
    expect(t.consecutiveQueryFailures).toBe(1);
  });

  test('other tool calls do not reset the streak', () => {
    const t = new SessionTracker();
    run(t, 'error');
    t.recordCall('show-table');
    run(t, 'error');
    expect(t.consecutiveQueryFailures).toBe(2);
  });
});

describe('execute-query error loop hint', () => {
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

  const text = (r: Awaited<ReturnType<Client['callTool']>>) =>
    (r.content as Array<{ type: string; text: string }>)[0].text;

  test('appears from the third failure in a row and clears after a success', async () => {
    const { client, close } = await connect();
    const query = () =>
      client.callTool({
        name: 'execute-query',
        arguments: { query: 'T | take 1' },
      });
    try {
      const failures: string[] = [];
      for (let i = 0; i < 4; i++) {
        (executeQuery as jest.Mock).mockRejectedValueOnce(
          new Error('Semantic error: bad column'),
        );
        const r = await query();
        expect(r.isError).toBe(true);
        failures.push(text(r));
      }
      expect(failures[0]).not.toContain(HINT);
      expect(failures[1]).not.toContain(HINT);
      expect(failures[2]).toContain('Semantic error: bad column');
      expect(failures[2].endsWith(`\n${HINT}`)).toBe(true);
      expect(failures[3].endsWith(`\n${HINT}`)).toBe(true);
      // Appended once, not stacked.
      expect(failures[3].split(HINT)).toHaveLength(2);

      const ok = await query();
      expect(ok.isError).toBeFalsy();

      (executeQuery as jest.Mock).mockRejectedValueOnce(new Error('again'));
      const after = await query();
      expect(after.isError).toBe(true);
      expect(text(after)).not.toContain(HINT);
    } finally {
      await close();
    }
  });

  test('never appended to other tools', async () => {
    const { client, close } = await connect();
    try {
      for (let i = 0; i < 3; i++) {
        (executeQuery as jest.Mock).mockRejectedValueOnce(new Error('x'));
        await client.callTool({
          name: 'execute-query',
          arguments: { query: 'T' },
        });
      }
      // The mocked connection cannot list tables, so show-tables errors.
      const r = await client.callTool({ name: 'show-tables', arguments: {} });
      expect(r.isError).toBe(true);
      expect(text(r)).not.toContain(HINT);
    } finally {
      await close();
    }
  });
});

describe('error loop hint ignores failures the query text cannot fix', () => {
  async function connect(config = {}, init = true) {
    const server = createKustoServer(config);
    const client = new Client({ name: 'unit-test', version: '0.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    if (init) {
      await client.callTool({
        name: 'initialize-connection',
        arguments: {
          cluster_url: 'https://x.kusto.windows.net',
          database: 'd',
        },
      });
    }
    return {
      client,
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  }
  const text = (r: Awaited<ReturnType<Client['callTool']>>) =>
    (r.content as Array<{ type: string; text: string }>)[0].text;

  test('tracker: non-query failures neither count nor reset the streak', () => {
    const t = new SessionTracker();
    t.beginQuery(20).finish({ status: 'error' });
    t.beginQuery(20).finish({ status: 'error', countsAsQueryFailure: false });
    expect(t.consecutiveQueryFailures).toBe(1);
    t.beginQuery(20).finish({ status: 'error' });
    expect(t.consecutiveQueryFailures).toBe(2);
  });

  test('not shown for "connection not initialized" errors', async () => {
    const { client, close } = await connect({}, false);
    try {
      for (let i = 0; i < 4; i++) {
        const r = await client.callTool({
          name: 'execute-query',
          arguments: { query: 'T | take 1' },
        });
        expect(r.isError).toBe(true);
        expect(text(r)).not.toContain(HINT);
      }
    } finally {
      await close();
    }
  });

  test('not shown for read-only blocks, which do not break a KQL streak', async () => {
    const { client, close } = await connect({ allowWriteOperations: false });
    const call = (query: string) =>
      client.callTool({ name: 'execute-query', arguments: { query } });
    try {
      for (let i = 0; i < 3; i++) {
        const r = await call('.drop table T');
        expect(r.isError).toBe(true);
        expect(text(r)).not.toContain(HINT);
      }
      (executeQuery as jest.Mock).mockRejectedValueOnce(new Error('bad 1'));
      await call('T | where x');
      await call('.drop table T');
      (executeQuery as jest.Mock).mockRejectedValueOnce(new Error('bad 2'));
      await call('T | where y');
      (executeQuery as jest.Mock).mockRejectedValueOnce(new Error('bad 3'));
      const third = await call('T | where z');
      expect(text(third).endsWith(`\n${HINT}`)).toBe(true);
    } finally {
      await close();
    }
  });
});

describe('error loop hint ignores timeouts and client cancels', () => {
  async function connect() {
    const server = createKustoServer({});
    const client = new Client({ name: 'unit-test', version: '0.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    await client.callTool({
      name: 'initialize-connection',
      arguments: { cluster_url: 'https://x.kusto.windows.net', database: 'd' },
    });
    const call = () =>
      client.callTool({
        name: 'execute-query',
        arguments: { query: 'T | take 1' },
      });
    return {
      call,
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  }
  const text = (r: Awaited<ReturnType<Client['callTool']>>) =>
    (r.content as Array<{ type: string; text: string }>)[0].text;
  const fail = (error: Error) =>
    (executeQuery as jest.Mock).mockRejectedValueOnce(error);
  const bad = () => fail(new Error('Semantic error: bad column'));
  const cancel = () =>
    fail(new KustoQueryCancelledError('Query cancelled by the client'));
  const timeout = () =>
    fail(new KustoTimeoutError('Query timed out after 120000ms'));

  test('three cancels then one bad query: no hint', async () => {
    const { call, close } = await connect();
    try {
      for (let i = 0; i < 3; i++) {
        cancel();
        expect(text(await call())).not.toContain(HINT);
      }
      bad();
      expect(text(await call())).not.toContain(HINT);
    } finally {
      await close();
    }
  });

  test('bad, cancel, bad: no hint until the third real KQL failure', async () => {
    const { call, close } = await connect();
    try {
      bad();
      expect(text(await call())).not.toContain(HINT);
      cancel();
      expect(text(await call())).not.toContain(HINT);
      bad();
      expect(text(await call())).not.toContain(HINT);
      bad();
      expect(text(await call()).endsWith(`\n${HINT}`)).toBe(true);
    } finally {
      await close();
    }
  });

  test('three timeouts: only the timeout hint, never the streak hint', async () => {
    const { call, close } = await connect();
    try {
      for (let i = 0; i < 3; i++) {
        timeout();
        const t = text(await call());
        expect(t).toContain('Narrow the time range');
        expect(t).not.toContain(HINT);
      }
    } finally {
      await close();
    }
  });

  test('two bad + timeout + bad: hint on the last bad query', async () => {
    const { call, close } = await connect();
    try {
      bad();
      await call();
      bad();
      await call();
      timeout();
      const t = text(await call());
      expect(t).toContain('Narrow the time range');
      expect(t).not.toContain(HINT);
      bad();
      expect(text(await call()).endsWith(`\n${HINT}`)).toBe(true);
    } finally {
      await close();
    }
  });
});
