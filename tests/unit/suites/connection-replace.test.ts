/**
 * Regression guard for #290: a failed initialize-connection must not replace
 * a working connection, identical concurrent calls share one connect, and
 * with differing concurrent calls the newest call that succeeds wins.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createKustoServer } from '../../../src/server.js';
import { KustoConfig } from '../../../src/types/config.js';
import {
  executeQuery,
  KustoConnection,
} from '../../../src/operations/kusto/index.js';

jest.mock('../../../src/common/version.js', () => ({ VERSION: '0.0.0-test' }));

jest.mock('../../../src/operations/kusto/index.js', () => {
  const actual = jest.requireActual('../../../src/operations/kusto/index.js');
  return {
    ...actual,
    KustoConnection: jest.fn(),
    executeQuery: jest.fn(async (conn: { cluster: string }) => {
      // Mirrors KustoConnection.executeQuery on an uninitialized instance.
      if (!conn.cluster) throw new Error('Connection not initialized');
      return {
        primaryResults: [
          {
            name: 'r',
            columns: [{ ColumnName: 'cluster' }],
            _rows: [[conn.cluster]],
          },
        ],
      };
    }),
  };
});

const MockConnection = KustoConnection as unknown as jest.Mock;

type InitBehavior = { delayMs: number; fail?: boolean };
type FakeConn = { cluster: string; close: jest.Mock };
// initialize() behavior per cluster URL; default is instant success.
let behaviors: Record<string, InitBehavior> = {};
let instances: FakeConn[] = [];
let initCalls: { cluster: string; source: string }[] = [];

beforeEach(() => {
  behaviors = {};
  instances = [];
  initCalls = [];
  (executeQuery as jest.Mock).mockClear();
  MockConnection.mockReset();
  MockConnection.mockImplementation(() => {
    const self = {
      cluster: '',
      close: jest.fn(),
      initialize: (cluster: string, database: string, source: string) => {
        initCalls.push({ cluster, source });
        const b = behaviors[cluster] ?? { delayMs: 0 };
        return new Promise((resolve, reject) =>
          setTimeout(() => {
            if (b.fail) {
              reject(new Error('connect failed'));
              return;
            }
            self.cluster = cluster;
            resolve({ success: true, cluster, database });
          }, b.delayMs),
        );
      },
    };
    instances.push(self);
    return self;
  });
});

async function connect(config: KustoConfig = {}) {
  const server = createKustoServer(config);
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

const text = (r: unknown) =>
  (r as { content: { text: string }[] }).content[0].text;

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

const A = 'https://a.kusto.windows.net';
const B = 'https://b.kusto.windows.net';
const BAD = 'https://typo.kusto.windows.net';

function init(client: Client, cluster: string, database = 'db') {
  return client.callTool({
    name: 'initialize-connection',
    arguments: { cluster_url: cluster, database },
  });
}

// Which cluster execute-query runs on now.
async function queryCluster(client: Client): Promise<string> {
  const r = await client.callTool({
    name: 'execute-query',
    arguments: { query: 'T | take 1' },
  });
  expect(r.isError).toBeFalsy();
  const calls = (executeQuery as jest.Mock).mock.calls;
  return calls[calls.length - 1][0].cluster;
}

describe('initialize-connection keeps a working connection (#290)', () => {
  test('a failed connect after a successful one leaves queries working', async () => {
    behaviors[BAD] = { delayMs: 0, fail: true };
    const { client, close } = await connect();
    try {
      expect((await init(client, A)).isError).toBeFalsy();
      const failed = await init(client, BAD);
      expect(failed.isError).toBe(true);
      expect(text(failed)).toMatch(/connect failed/);

      for (let i = 0; i < 3; i++) {
        expect(await queryCluster(client)).toBe(A);
      }
      expect(instances[0].close).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  test('5 identical concurrent calls share one connect', async () => {
    behaviors[A] = { delayMs: 100 };
    const { client, close } = await connect();
    try {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => init(client, A)),
      );
      for (const r of results) {
        expect(r.isError).toBeFalsy();
        expect(JSON.parse(text(r)).cluster).toBe(A);
      }
      expect(MockConnection).toHaveBeenCalledTimes(1);
      expect(initCalls).toEqual([{ cluster: A, source: 'manual' }]);
      expect(await queryCluster(client)).toBe(A);

      // Once settled, a new call connects again.
      expect((await init(client, A)).isError).toBeFalsy();
      expect(MockConnection).toHaveBeenCalledTimes(2);
    } finally {
      await close();
    }
  });

  test('identical concurrent calls that fail all see the failure, once', async () => {
    behaviors[BAD] = { delayMs: 50, fail: true };
    const { client, close } = await connect();
    try {
      expect((await init(client, A)).isError).toBeFalsy();
      const results = await Promise.all(
        Array.from({ length: 5 }, () => init(client, BAD)),
      );
      for (const r of results) expect(r.isError).toBe(true);
      expect(initCalls.filter(c => c.cluster === BAD)).toHaveLength(1);
      expect(await queryCluster(client)).toBe(A);
    } finally {
      await close();
    }
  });

  test('same cluster, different database is a separate connect', async () => {
    behaviors[A] = { delayMs: 50 };
    const { client, close } = await connect();
    try {
      await Promise.all([init(client, A, 'db1'), init(client, A, 'db2')]);
      expect(MockConnection).toHaveBeenCalledTimes(2);
    } finally {
      await close();
    }
  });

  test('differing concurrent calls: the newer call wins even if it finishes first', async () => {
    behaviors[A] = { delayMs: 150 };
    behaviors[B] = { delayMs: 0 };
    const { client, close } = await connect();
    try {
      const [ra, rb] = await Promise.all([init(client, A), init(client, B)]);
      expect(ra.isError).toBeFalsy();
      expect(rb.isError).toBeFalsy();
      expect(await queryCluster(client)).toBe(B);
      // The superseded connection is released; the one in use is not.
      expect(instances[0].close).toHaveBeenCalled();
      expect(instances[1].close).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  test('differing concurrent calls: the newer call wins when it finishes last', async () => {
    behaviors[A] = { delayMs: 0 };
    behaviors[B] = { delayMs: 150 };
    const { client, close } = await connect();
    try {
      await Promise.all([init(client, A), init(client, B)]);
      expect(await queryCluster(client)).toBe(B);
    } finally {
      await close();
    }
  });

  test('a newer call that fails leaves the older successful one in place', async () => {
    behaviors[A] = { delayMs: 150 };
    behaviors[BAD] = { delayMs: 0, fail: true };
    const { client, close } = await connect();
    try {
      const [ra, rbad] = await Promise.all([
        init(client, A),
        init(client, BAD),
      ]);
      expect(ra.isError).toBeFalsy();
      expect(rbad.isError).toBe(true);
      expect(await queryCluster(client)).toBe(A);
    } finally {
      await close();
    }
  });

  test('joining an in-flight connect counts as the newest call', async () => {
    behaviors[A] = { delayMs: 150 };
    behaviors[B] = { delayMs: 0 };
    const { client, close } = await connect();
    try {
      // A starts, then B, then A again (joins the first A connect).
      const pa = init(client, A);
      await delay(10);
      const pb = init(client, B);
      await delay(10);
      const pa2 = init(client, A);
      await Promise.all([pa, pb, pa2]);
      expect(MockConnection).toHaveBeenCalledTimes(2);
      expect(await queryCluster(client)).toBe(A);
    } finally {
      await close();
    }
  });

  test('a late auto-connect does not overwrite a manual connection', async () => {
    const AUTO = 'https://auto.kusto.windows.net';
    behaviors[AUTO] = { delayMs: 150 };
    const { client, close } = await connect({
      clusterUrl: AUTO,
      defaultDatabase: 'db',
    });
    try {
      expect((await init(client, A)).isError).toBeFalsy();
      await delay(250); // let the auto-connect succeed
      expect(initCalls.map(c => c.source)).toEqual(['auto', 'manual']);
      expect(await queryCluster(client)).toBe(A);
      // The discarded auto-connect client is released.
      expect(instances[0].cluster).toBe(AUTO);
      expect(instances[0].close).toHaveBeenCalled();
    } finally {
      await close();
    }
  });
});
