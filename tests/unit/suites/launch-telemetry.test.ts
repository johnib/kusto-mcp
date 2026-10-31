/**
 * Launch-level telemetry: config validity read before any fallback, whether
 * the machine id persisted, the MCP client joined to the startup auto-connect
 * (#379), and the auto-connect skip exported before a short-lived launch dies.
 *
 * tests/unit/setup.ts points XDG_DATA_HOME/LOCALAPPDATA at a fresh temp dir
 * per test.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  authMethodState,
  clusterUrlState,
  configStateAttributes,
  timeoutState,
} from '../../../src/common/config-state.js';
import {
  autoConnectKey,
  beginAutoConnect,
} from '../../../src/common/autoconnect-backoff.js';
import { loadOrCreateMachineId } from '../../../src/common/machine-id.js';
import { createKustoServer } from '../../../src/server.js';
import { KustoConnection } from '../../../src/operations/kusto/index.js';
import { emitLog, flushLogs } from '../../../src/common/telemetry.js';

jest.mock('../../../src/common/version.js', () => ({ VERSION: '0.0.0-test' }));
jest.mock('../../../src/common/telemetry.js', () => ({
  ...jest.requireActual('../../../src/common/telemetry.js'),
  emitLog: jest.fn(),
  flushLogs: jest.fn(async () => undefined),
}));
jest.mock('../../../src/operations/kusto/index.js', () => ({
  ...jest.requireActual('../../../src/operations/kusto/index.js'),
  KustoConnection: jest.fn(() => ({
    initialize: async (cluster: string, database: string) => ({
      success: true,
      cluster,
      database,
    }),
  })),
}));

const logs = emitLog as jest.Mock;

beforeEach(() => {
  logs.mockClear();
  (flushLogs as jest.Mock).mockClear();
  (KustoConnection as unknown as jest.Mock).mockClear();
});

describe('config state (read before fallback)', () => {
  test.each([
    [undefined, 'unset'],
    ['', 'unset'],
    ['azure-cli', 'valid'],
    ['Azure-Identity', 'valid'],
    [' azure-cli ', 'whitespace'],
    ['azurecli', 'invalid'],
  ])('auth method %p → %s', (raw, state) => {
    expect(authMethodState(raw)).toBe(state);
  });

  test.each([
    [undefined, 'unset'],
    ['30000', 'valid'],
    ['abc', 'invalid'],
    ['20s', 'invalid'],
    ['-5', 'invalid'],
    ['0', 'invalid'],
  ])('timeout %p → %s', (raw, state) => {
    expect(timeoutState(raw)).toBe(state);
  });

  test.each([
    [undefined, 'unset'],
    ['  ', 'unset'],
    ['https://help.kusto.windows.net', 'valid'],
    ['help.kusto.windows.net', 'no_scheme'],
    ['help.kusto.windows.net/', 'no_scheme'],
    ['not a url', 'invalid'],
  ])('cluster url %p → %s', (raw, state) => {
    expect(clusterUrlState(raw)).toBe(state);
  });

  test('attributes carry states only, never the values', () => {
    const attrs = configStateAttributes({
      KUSTO_AUTH_METHOD: 'secret-typo',
      KUSTO_CONNECTION_TIMEOUT: 'abc',
      KUSTO_CLUSTER_URL: 'mycorp.kusto.windows.net',
    });
    expect(attrs).toEqual({
      'kustomcp.config.auth_method_state': 'invalid',
      'kustomcp.config.connection_timeout_state': 'invalid',
      'kustomcp.config.cluster_url_state': 'no_scheme',
    });
  });
});

describe('machine id persistence', () => {
  test('a written id is persisted, also on the next launch', () => {
    expect(loadOrCreateMachineId().persisted).toBe(true);
    expect(loadOrCreateMachineId()).toMatchObject({
      persisted: true,
      isFirstRun: false,
    });
  });

  test('an unwritable state dir reports persisted=false', () => {
    const blocker = join(tmpdir(), `kusto-mcp-blocker-${process.pid}`);
    writeFileSync(blocker, 'not a dir');
    const prev = {
      xdg: process.env.XDG_DATA_HOME,
      local: process.env.LOCALAPPDATA,
    };
    process.env.XDG_DATA_HOME = blocker;
    process.env.LOCALAPPDATA = blocker;
    try {
      expect(loadOrCreateMachineId()).toMatchObject({
        persisted: false,
        isFirstRun: true,
      });
    } finally {
      process.env.XDG_DATA_HOME = prev.xdg;
      process.env.LOCALAPPDATA = prev.local;
    }
  });
});

async function launch(config: Parameters<typeof createKustoServer>[0]) {
  const server = createKustoServer(config);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 'probe-client', version: '9.9' });
  await client.connect(clientT);
  await new Promise(r => setImmediate(r));
  return { server, client };
}

describe('MCP client identified (#379)', () => {
  test('after the handshake, one log names the client and the gap', async () => {
    const { client } = await launch({
      clusterUrl: 'https://c.kusto.windows.net',
      defaultDatabase: 'db',
    });
    const identified = logs.mock.calls.filter(
      c => c[2] === 'MCP client identified',
    );
    expect(identified).toHaveLength(1);
    expect(identified[0][3]).toMatchObject({
      'mcp.client.name': 'probe-client',
      'mcp.client.version': '9.9',
    });
    expect(typeof identified[0][3]['kustomcp.handshake_gap_ms']).toBe(
      'number',
    );
    await client.close();
  });
});

describe('auto-connect skip is exported at once', () => {
  test('a skipped launch flushes its log', async () => {
    const key = autoConnectKey(
      'https://c.kusto.windows.net',
      'db',
      'azure-identity',
    );
    const now = Date.now();
    for (let i = 0; i < 3; i++) beginAutoConnect(key, now - 3 + i);
    const { client } = await launch({
      clusterUrl: 'https://c.kusto.windows.net',
      defaultDatabase: 'db',
    });
    expect(KustoConnection).not.toHaveBeenCalled();
    expect(
      logs.mock.calls.some(c => c[2] === 'Auto-connection skipped'),
    ).toBe(true);
    expect(flushLogs).toHaveBeenCalled();
    await client.close();
  });
});
