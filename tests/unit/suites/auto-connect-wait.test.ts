/**
 * Regression guard for #311: a tool call that arrives while the configured
 * auto-connect is still in flight must wait for it (bounded by
 * connectionTimeout) instead of failing with "Connection not initialized".
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createKustoServer } from '../../../src/server.js';
import { KustoConfig } from '../../../src/types/config.js';
import {
  KustoConnection,
  showTables,
} from '../../../src/operations/kusto/index.js';

jest.mock('../../../src/common/version.js', () => ({ VERSION: '0.0.0-test' }));

jest.mock('../../../src/operations/kusto/index.js', () => {
  const actual = jest.requireActual('../../../src/operations/kusto/index.js');
  return {
    ...actual,
    KustoConnection: jest.fn(),
    showTables: jest.fn(async (conn: { cluster: string }) => ({
      cluster: conn.cluster,
    })),
  };
});

const MockConnection = KustoConnection as unknown as jest.Mock;

// Each initialize() call consumes the next behavior from this queue.
type InitBehavior = { delayMs: number; fail?: boolean; hang?: boolean };
let behaviors: InitBehavior[] = [];
let initCalls: string[] = [];

beforeEach(() => {
  behaviors = [];
  initCalls = [];
  (showTables as jest.Mock).mockClear();
  MockConnection.mockReset();
  MockConnection.mockImplementation(() => {
    const self = {
      cluster: '',
      initialize: (cluster: string, database: string, source: string) => {
        initCalls.push(source);
        const b = behaviors.shift() ?? { delayMs: 0 };
        if (b.hang) return new Promise(() => {});
        return new Promise((resolve, reject) =>
          setTimeout(() => {
            if (b.fail) {
              reject(new Error('connect failed'));
              return;
            }
            self.cluster = cluster;
            resolve({ cluster, database });
          }, b.delayMs),
        );
      },
    };
    return self;
  });
});

const CONFIGURED: KustoConfig = {
  clusterUrl: 'https://auto.kusto.windows.net',
  defaultDatabase: 'db',
};

async function connect(config: KustoConfig) {
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

describe('tool calls wait for auto-connect (#311)', () => {
  test('a call made while auto-connect is in flight waits and succeeds', async () => {
    behaviors = [{ delayMs: 150 }];
    const { client, close } = await connect(CONFIGURED);
    try {
      const r = await client.callTool({ name: 'show-tables', arguments: {} });
      expect(r.isError).toBeFalsy();
      expect(JSON.parse(text(r)).cluster).toBe(
        'https://auto.kusto.windows.net',
      );
      expect(initCalls).toEqual(['auto']);
    } finally {
      await close();
    }
  });

  test('after a failed auto-connect, the next call starts a new attempt', async () => {
    behaviors = [{ delayMs: 0, fail: true }, { delayMs: 50 }];
    const { client, close } = await connect(CONFIGURED);
    try {
      await delay(20); // let the startup attempt fail
      const r = await client.callTool({ name: 'show-tables', arguments: {} });
      expect(r.isError).toBeFalsy();
      expect(initCalls).toEqual(['auto', 'auto']);
    } finally {
      await close();
    }
  });

  test('a hung auto-connect is bounded by connectionTimeout', async () => {
    behaviors = [{ delayMs: 0, hang: true }];
    const { client, close } = await connect({
      ...CONFIGURED,
      connectionTimeout: 100,
    });
    try {
      const started = Date.now();
      const r = await client.callTool({ name: 'show-tables', arguments: {} });
      expect(Date.now() - started).toBeLessThan(2000);
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/Connection not initialized/);
    } finally {
      await close();
    }
  });

  test('without cluster/database configured, the error is immediate and unchanged', async () => {
    const { client, close } = await connect({});
    try {
      const r = await client.callTool({ name: 'show-tables', arguments: {} });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(
        /Connection not initialized\. Please call initialize-connection first\./,
      );
      expect(initCalls).toEqual([]);
      expect(showTables).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  test('a manual connect still wins over a slower pending auto-connect', async () => {
    behaviors = [{ delayMs: 200 }, { delayMs: 0 }];
    const { client, close } = await connect(CONFIGURED);
    try {
      const m = await client.callTool({
        name: 'initialize-connection',
        arguments: {
          cluster_url: 'https://manual.kusto.windows.net',
          database: 'db',
        },
      });
      expect(m.isError).toBeFalsy();
      await delay(300); // let the auto-connect finish
      const r = await client.callTool({ name: 'show-tables', arguments: {} });
      expect(r.isError).toBeFalsy();
      expect(JSON.parse(text(r)).cluster).toBe(
        'https://manual.kusto.windows.net',
      );
    } finally {
      await close();
    }
  });
});
