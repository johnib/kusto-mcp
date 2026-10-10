/**
 * #321 — the default query timeout is 120s, and a running execute-query sends
 * MCP progress notifications (~every 15s) when the request carries a
 * progressToken, so hosts that extend their own timeout on progress keep the
 * call alive.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Progress } from '@modelcontextprotocol/sdk/types.js';
import { Client as KustoClient } from 'azure-kusto-data';
import { createKustoServer } from '../../../src/server.js';
import {
  AuthenticationMethod,
  DEFAULT_CONFIG,
} from '../../../src/types/config.js';

jest.mock('../../../src/common/version.js', () => ({ VERSION: '0.0.0-test' }));

const ok = { primaryResults: [{ name: 'r', columns: [], _rows: [] }] };

async function connect() {
  const server = createKustoServer({
    authMethod: AuthenticationMethod.AzureCli,
    queryTimeout: 600000,
  });
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

/** Mock Kusto: the probe succeeds; the user query resolves when released. */
function slowQuery() {
  let release: (v: unknown) => void = () => {};
  let started = false;
  jest
    .spyOn(KustoClient.prototype, 'execute')
    .mockImplementation(async (_db: string | null, q: string) => {
      if (q === 'print now()') return ok as never;
      started = true;
      return new Promise(r => (release = r)) as never;
    });
  return { release: () => release(ok), started: () => started };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
};

describe('default query timeout (#321)', () => {
  test('defaults to 120s', () => {
    expect(DEFAULT_CONFIG.queryTimeout).toBe(120000);
  });
});

describe('execute-query progress notifications (#321)', () => {
  beforeEach(() => {
    // Fake only the interval timers; promises, setTimeout and setImmediate
    // stay real so the in-memory transport keeps working.
    jest.useFakeTimers({
      doNotFake: [
        'setTimeout',
        'clearTimeout',
        'setImmediate',
        'clearImmediate',
        'nextTick',
        'queueMicrotask',
        'Date',
        'performance',
        'hrtime',
      ],
    });
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('sends progress every 15s while a slow query runs, and stops after', async () => {
    const q = slowQuery();
    const { client, close } = await connect();
    try {
      const progress: Progress[] = [];
      const pending = client.callTool(
        { name: 'execute-query', arguments: { query: 'T | count' } },
        undefined,
        { onprogress: p => progress.push(p) },
      );
      while (!q.started()) await flush();

      jest.advanceTimersByTime(15000);
      await flush();
      expect(progress).toHaveLength(1);

      jest.advanceTimersByTime(15000);
      await flush();
      expect(progress).toHaveLength(2);
      expect(progress[1].progress).toBeGreaterThan(progress[0].progress);

      q.release();
      const r = await pending;
      expect(r.isError).toBeFalsy();

      // The heartbeat is cleared once the query settles.
      jest.advanceTimersByTime(60000);
      await flush();
      expect(progress).toHaveLength(2);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      await close();
    }
  });

  test('no progressToken → no progress notifications, no timer left behind', async () => {
    const q = slowQuery();
    const { client, close } = await connect();
    try {
      const sent: string[] = [];
      client.fallbackNotificationHandler = async n => {
        sent.push(n.method);
      };
      const pending = client.callTool({
        name: 'execute-query',
        arguments: { query: 'T | count' },
      });
      while (!q.started()) await flush();
      expect(jest.getTimerCount()).toBe(0);
      jest.advanceTimersByTime(30000);
      await flush();
      q.release();
      await pending;
      expect(sent).not.toContain('notifications/progress');
    } finally {
      await close();
    }
  });

  test('a failing query clears the heartbeat', async () => {
    jest
      .spyOn(KustoClient.prototype, 'execute')
      .mockImplementation(async (_db: string | null, q: string) => {
        if (q === 'print now()') return ok as never;
        throw new Error('boom');
      });
    const { client, close } = await connect();
    try {
      const r = await client.callTool(
        { name: 'execute-query', arguments: { query: 'T | count' } },
        undefined,
        { onprogress: () => {} },
      );
      expect(r.isError).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      await close();
    }
  });
});
