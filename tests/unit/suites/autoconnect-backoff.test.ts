/**
 * Regression guard for #316: hosts that relaunch the server again and again
 * must not retry the startup auto-connect on every launch. Failed startup
 * attempts are remembered in the local state dir (per auto-connect config)
 * and, after a few in a row, startup auto-connect is skipped for a capped,
 * doubling cooldown. Manual initialize-connection is never gated.
 *
 * tests/unit/setup.ts points XDG_DATA_HOME/LOCALAPPDATA at a fresh temp dir
 * per test, so every "launch" below shares that test's state dir.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  autoConnectKey,
  beginAutoConnect,
  clearAutoConnectBackoff,
  cooldownMs,
} from '../../../src/common/autoconnect-backoff.js';
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

let failNext: boolean[] = [];
let initCalls: string[] = [];

beforeEach(() => {
  failNext = [];
  initCalls = [];
  MockConnection.mockReset();
  MockConnection.mockImplementation(() => {
    const self = {
      cluster: '',
      initialize: async (cluster: string, database: string, source: string) => {
        initCalls.push(source);
        if (failNext.shift()) throw new Error('connect failed');
        self.cluster = cluster;
        return { success: true, cluster, database };
      },
    };
    return self;
  });
});

const stateFile = () =>
  join(process.env.XDG_DATA_HOME as string, 'kusto-mcp', 'autoconnect_backoff');

const KEY = autoConnectKey('https://c.kusto.windows.net', 'db', 'azure-cli');
const T0 = 1_700_000_000_000;

describe('auto-connect backoff state (#316)', () => {
  test('cooldown starts after 3 failures, doubles, and caps at 10 minutes', () => {
    expect([1, 2, 3, 4, 5, 8, 50].map(cooldownMs)).toEqual([
      0, 0, 30_000, 60_000, 120_000, 600_000, 600_000,
    ]);
  });

  test('backoff kicks in after 3 consecutive attempts within the window', () => {
    expect(beginAutoConnect(KEY, T0).skip).toBe(false);
    expect(beginAutoConnect(KEY, T0 + 1000).skip).toBe(false);
    expect(beginAutoConnect(KEY, T0 + 2000).skip).toBe(false);
    const skipped = beginAutoConnect(KEY, T0 + 3000);
    expect(skipped).toEqual({ skip: true, retryInMs: 29_000 });
    // Skips don't extend the streak; once the cooldown passes, it retries...
    expect(beginAutoConnect(KEY, T0 + 2000 + 30_000).skip).toBe(false);
    // ...and the next cooldown is doubled.
    expect(beginAutoConnect(KEY, T0 + 2000 + 30_000 + 59_000).skip).toBe(true);
    expect(beginAutoConnect(KEY, T0 + 2000 + 30_000 + 60_000).skip).toBe(false);
  });

  test('a config change resets the streak', () => {
    for (let i = 0; i < 3; i++) beginAutoConnect(KEY, T0 + i);
    expect(beginAutoConnect(KEY, T0 + 10).skip).toBe(true);
    const other = autoConnectKey(
      'https://c.kusto.windows.net',
      'db2',
      'azure-cli',
    );
    expect(other).not.toBe(KEY);
    expect(beginAutoConnect(other, T0 + 10).skip).toBe(false);
    const otherAuth = autoConnectKey(
      'https://c.kusto.windows.net',
      'db',
      'azure-identity',
    );
    expect(otherAuth).not.toBe(KEY);
  });

  test('a success clears the streak', () => {
    for (let i = 0; i < 3; i++) beginAutoConnect(KEY, T0 + i);
    clearAutoConnectBackoff(KEY);
    expect(beginAutoConnect(KEY, T0 + 10).skip).toBe(false);
    clearAutoConnectBackoff(KEY);
    clearAutoConnectBackoff(KEY); // no file: still fine
  });

  test('alternating configs each keep their own streak and back off (#441)', () => {
    const B = autoConnectKey('https://c.kusto.windows.net', 'db2', 'azure-cli');
    for (let i = 0; i < 3; i++) {
      expect(beginAutoConnect(KEY, T0 + i * 2).skip).toBe(false);
      expect(beginAutoConnect(B, T0 + i * 2 + 1).skip).toBe(false);
    }
    expect(beginAutoConnect(KEY, T0 + 10).skip).toBe(true);
    expect(beginAutoConnect(B, T0 + 11).skip).toBe(true);
  });

  test('a success of one config does not clear the streak of another (#441)', () => {
    const B = autoConnectKey('https://c.kusto.windows.net', 'db2', 'azure-cli');
    for (let i = 0; i < 3; i++) {
      beginAutoConnect(KEY, T0 + i * 2);
      beginAutoConnect(B, T0 + i * 2 + 1);
    }
    clearAutoConnectBackoff(B);
    expect(beginAutoConnect(B, T0 + 10).skip).toBe(false);
    expect(beginAutoConnect(KEY, T0 + 10).skip).toBe(true);
  });

  test('the number of stored configs stays bounded (#441)', () => {
    for (let i = 0; i < 100; i++) {
      beginAutoConnect(autoConnectKey('https://c', `db${i}`, 'x'), T0 + i);
    }
    const state = JSON.parse(readFileSync(stateFile(), 'utf8'));
    expect(Object.keys(state.keys).length).toBeLessThanOrEqual(16);
    // The newest config is kept.
    expect(state.keys[autoConnectKey('https://c', 'db99', 'x')]).toEqual([
      T0 + 99,
    ]);
  });

  test('configs whose attempts are all outside the window are dropped (#441)', () => {
    const B = autoConnectKey('https://c.kusto.windows.net', 'db2', 'azure-cli');
    beginAutoConnect(B, T0);
    beginAutoConnect(KEY, T0 + 61 * 60_000);
    const state = JSON.parse(readFileSync(stateFile(), 'utf8'));
    expect(Object.keys(state.keys)).toEqual([KEY]);
  });

  test('the old single-record file format is migrated (#441)', () => {
    mkdirSync(join(process.env.XDG_DATA_HOME as string, 'kusto-mcp'), {
      recursive: true,
    });
    writeFileSync(
      stateFile(),
      JSON.stringify({ key: KEY, attempts: [T0, T0 + 1, T0 + 2] }),
    );
    // The old streak still counts for its config.
    expect(beginAutoConnect(KEY, T0 + 10).skip).toBe(true);
    const B = autoConnectKey('https://c.kusto.windows.net', 'db2', 'azure-cli');
    expect(beginAutoConnect(B, T0 + 10).skip).toBe(false);
    const state = JSON.parse(readFileSync(stateFile(), 'utf8'));
    expect(state.keys[KEY]).toEqual([T0, T0 + 1, T0 + 2]);
    expect(state.keys[B]).toEqual([T0 + 10]);
  });

  test('only attempts within the last hour count (rolling window)', () => {
    const MIN = 60_000;
    // 3 attempts 40 minutes apart: at the 3rd, only 2 are within the hour.
    expect(beginAutoConnect(KEY, T0).skip).toBe(false);
    expect(beginAutoConnect(KEY, T0 + 40 * MIN).skip).toBe(false);
    expect(beginAutoConnect(KEY, T0 + 80 * MIN).skip).toBe(false);
    expect(beginAutoConnect(KEY, T0 + 80 * MIN + 1000).skip).toBe(false);
    // Now 3 are within the hour (40m, 80m, 80m+1s): the next one backs off.
    expect(beginAutoConnect(KEY, T0 + 80 * MIN + 2000).skip).toBe(true);
  });

  test('the stored attempt list stays bounded', () => {
    for (let i = 0; i < 100; i++) beginAutoConnect(KEY, T0 + i * 10 * 60_000);
    const state = JSON.parse(readFileSync(stateFile(), 'utf8'));
    expect(state.keys[KEY].length).toBeLessThanOrEqual(20);
  });

  test('an old streak or a clock that went backwards does not block', () => {
    for (let i = 0; i < 3; i++) beginAutoConnect(KEY, T0 + i);
    expect(beginAutoConnect(KEY, T0 + 2 + 61 * 60_000).skip).toBe(false);
    for (let i = 0; i < 3; i++) beginAutoConnect(KEY, T0 + i);
    expect(beginAutoConnect(KEY, T0 - 5000).skip).toBe(false);
  });

  test.each([
    ['garbage', 'not json{'],
    ['wrong shape', '{"key":1,"failures":"x"}'],
    ['keys not an object', '{"keys":[1,2]}'],
    ['null', 'null'],
    ['non-numeric attempt', JSON.stringify({ key: KEY, attempts: ['x'] })],
    ['attempts not a list', JSON.stringify({ key: KEY, attempts: 5 })],
    ['empty', ''],
  ])('a corrupted state file (%s) is ignored and replaced', (_n, content) => {
    mkdirSync(join(process.env.XDG_DATA_HOME as string, 'kusto-mcp'), {
      recursive: true,
    });
    writeFileSync(stateFile(), content);
    expect(beginAutoConnect(KEY, T0)).toEqual({ skip: false, retryInMs: 0 });
    expect(JSON.parse(readFileSync(stateFile(), 'utf8'))).toEqual({
      keys: { [KEY]: [T0] },
    });
  });

  test('an unwritable state dir never throws and never blocks', () => {
    // The state dir path is occupied by a regular file, so mkdir/write fail.
    const base = join(process.env.XDG_DATA_HOME as string, 'blocked');
    writeFileSync(base, 'x');
    process.env.XDG_DATA_HOME = base;
    for (let i = 0; i < 5; i++) {
      expect(beginAutoConnect(KEY, T0 + i)).toEqual({
        skip: false,
        retryInMs: 0,
      });
    }
    expect(() => clearAutoConnectBackoff(KEY)).not.toThrow();
  });
});

const CONFIGURED: KustoConfig = {
  clusterUrl: 'https://auto.kusto.windows.net',
  defaultDatabase: 'db',
};

const text = (r: unknown) =>
  (r as { content: { text: string }[] }).content[0].text;

/** One server "launch": connect a client, call show-tables once (which waits for the startup auto-connect), close. */
async function launch(
  config: KustoConfig,
  after?: (c: Client) => Promise<void>,
) {
  const server = createKustoServer(config);
  const client = new Client({ name: 'unit-test', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const r = await client.callTool({ name: 'show-tables', arguments: {} });
    if (after) await after(client);
    return r;
  } finally {
    await client.close();
    await server.close();
  }
}

describe('startup auto-connect across launches (#316)', () => {
  test('after 3 failed launches the next launch skips auto-connect and fails fast with a clear message', async () => {
    failNext = [true, true, true];
    for (let i = 0; i < 3; i++) {
      const r = await launch(CONFIGURED);
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/Please call initialize-connection first\./);
    }
    expect(initCalls).toEqual(['auto', 'auto', 'auto']);

    const started = Date.now();
    const r = await launch(CONFIGURED);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(initCalls).toEqual(['auto', 'auto', 'auto']); // no 4th attempt
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(
      /auto-connect is paused after repeated failed attempts.*initialize-connection/,
    );
    expect(showTables).not.toHaveBeenCalled();
  });

  test('manual initialize-connection works while paused and clears only its own config', async () => {
    failNext = [true, true, true];
    for (let i = 0; i < 3; i++) await launch(CONFIGURED);

    await launch(CONFIGURED, async client => {
      const m = await client.callTool({
        name: 'initialize-connection',
        arguments: {
          cluster_url: 'https://manual.kusto.windows.net',
          database: 'db',
        },
      });
      expect(m.isError).toBeFalsy();
      const r = await client.callTool({ name: 'show-tables', arguments: {} });
      expect(r.isError).toBeFalsy();
      expect(JSON.parse(text(r)).cluster).toBe(
        'https://manual.kusto.windows.net',
      );
    });
    expect(initCalls).toEqual(['auto', 'auto', 'auto', 'manual']);

    // A manual connect to another cluster does not clear the broken startup
    // config (#441): the next launch is still paused.
    await launch(CONFIGURED);
    expect(initCalls).toEqual(['auto', 'auto', 'auto', 'manual']);

    // A manual connect to the startup config itself clears its streak.
    await launch(CONFIGURED, async client => {
      const m = await client.callTool({
        name: 'initialize-connection',
        arguments: {
          cluster_url: CONFIGURED.clusterUrl as string,
          database: CONFIGURED.defaultDatabase as string,
        },
      });
      expect(m.isError).toBeFalsy();
    });
    expect(initCalls).toEqual(['auto', 'auto', 'auto', 'manual', 'manual']);

    // Cleared: the next launch tries auto-connect again.
    const r = await launch(CONFIGURED);
    expect(r.isError).toBeFalsy();
    expect(initCalls).toEqual([
      'auto',
      'auto',
      'auto',
      'manual',
      'manual',
      'auto',
    ]);
  });

  test('a successful auto-connect clears the streak', async () => {
    failNext = [true, true, false, true, true];
    for (let i = 0; i < 5; i++) await launch(CONFIGURED);
    // 2 failures, a success, then 2 failures: never 3 in a row, never skipped.
    expect(initCalls).toEqual(['auto', 'auto', 'auto', 'auto', 'auto']);
  });

  test('two configs that alternate across launches both back off (#441)', async () => {
    const OTHER = { ...CONFIGURED, defaultDatabase: 'other' };
    failNext = [true, true, true, true, true, true];
    for (let i = 0; i < 3; i++) {
      await launch(CONFIGURED);
      await launch(OTHER);
    }
    expect(initCalls).toHaveLength(6);
    await launch(CONFIGURED);
    await launch(OTHER);
    expect(initCalls).toHaveLength(6); // both skipped
  });

  test('a successful auto-connect of one config keeps the streak of another (#441)', async () => {
    const OTHER = { ...CONFIGURED, defaultDatabase: 'other' };
    failNext = [true, true, true];
    for (let i = 0; i < 3; i++) await launch(CONFIGURED);
    const ok = await launch(OTHER);
    expect(ok.isError).toBeFalsy();
    expect(initCalls).toHaveLength(4);
    await launch(CONFIGURED); // still paused
    expect(initCalls).toHaveLength(4);
  });

  test('changing the auto-connect database retries immediately', async () => {
    failNext = [true, true, true];
    for (let i = 0; i < 3; i++) await launch(CONFIGURED);
    await launch(CONFIGURED); // skipped
    expect(initCalls).toHaveLength(3);
    const r = await launch({ ...CONFIGURED, defaultDatabase: 'fixed' });
    expect(r.isError).toBeFalsy();
    expect(initCalls).toHaveLength(4);
  });
});
