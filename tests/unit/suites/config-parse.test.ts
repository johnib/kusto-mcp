/**
 * Connection settings are validated instead of silently misbehaving:
 * - a non-numeric timeout became NaN, and setTimeout(NaN) fires in ~1ms (#288);
 * - a mistyped or padded KUSTO_AUTH_METHOD fell back without notice (#289);
 * - a cluster URL without https:// failed as an unclassified error;
 * - validateConfig let an explicit `undefined` overwrite a default (#286).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  parseAuthMethod,
  parseIntSetting,
  withScheme,
} from '../../../src/common/config-parse.js';
import { KustoConnection } from '../../../src/operations/kusto/index.js';
import { createKustoServer } from '../../../src/server.js';
import {
  AuthenticationMethod,
  validateConfig,
} from '../../../src/types/config.js';

jest.mock('../../../src/common/version.js', () => ({ VERSION: '0.0.0-test' }));
const connectedTo: string[] = [];
jest.mock('../../../src/operations/kusto/index.js', () => ({
  ...jest.requireActual('../../../src/operations/kusto/index.js'),
  KustoConnection: jest.fn(() => ({
    initialize: async (cluster: string, database: string) => {
      connectedTo.push(cluster);
      return { success: true, cluster, database };
    },
  })),
}));

describe('parseIntSetting', () => {
  test.each([
    [undefined, undefined, 0],
    ['', undefined, 0],
    ['30000', 30000, 0],
    [' 30000 ', 30000, 0],
    ['abc', undefined, 1],
    ['20s', undefined, 1],
    ['0', undefined, 1],
    ['-5', undefined, 1],
    ['2147483648', undefined, 1],
  ])('%p → %p (%d warnings)', (raw, value, warningCount) => {
    const warnings: string[] = [];
    expect(parseIntSetting('KUSTO_CONNECTION_TIMEOUT', raw, warnings)).toBe(
      value,
    );
    expect(warnings).toHaveLength(warningCount);
    if (warningCount) expect(warnings[0]).toMatch(/KUSTO_CONNECTION_TIMEOUT/);
  });

  test('a minimum of 0 accepts 0', () => {
    expect(parseIntSetting('X', '0', [], { min: 0 })).toBe(0);
  });
});

describe('parseAuthMethod', () => {
  test.each([
    [undefined, AuthenticationMethod.AzureIdentity, 0],
    ['azure-cli', AuthenticationMethod.AzureCli, 0],
    [' Azure-CLI ', AuthenticationMethod.AzureCli, 0],
    ['azurecli', AuthenticationMethod.AzureIdentity, 1],
  ])('%p → %s (%d warnings)', (raw, method, warningCount) => {
    const warnings: string[] = [];
    expect(parseAuthMethod(raw, warnings)).toBe(method);
    expect(warnings).toHaveLength(warningCount);
  });
});

describe('withScheme', () => {
  test.each([
    ['help.kusto.windows.net', 'https://help.kusto.windows.net'],
    [' help.kusto.windows.net/ ', 'https://help.kusto.windows.net/'],
    ['https://help.kusto.windows.net', 'https://help.kusto.windows.net'],
    ['http://localhost:8080', 'http://localhost:8080'],
    ['not a url', 'not a url'],
  ])('%p → %p', (raw, url) => {
    expect(withScheme(raw)).toBe(url);
  });
});

test('validateConfig keeps defaults over explicit undefined (#286)', () => {
  expect(
    validateConfig({ markdownMaxCellLength: undefined }).markdownMaxCellLength,
  ).toBe(1000);
});

test('initialize-connection accepts a bare cluster host', async () => {
  connectedTo.length = 0;
  const server = createKustoServer({});
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(clientT);
  const r = await client.callTool({
    name: 'initialize-connection',
    arguments: { cluster_url: 'help.kusto.windows.net', database: 'Samples' },
  });
  expect(r.isError).toBeFalsy();
  expect(connectedTo).toEqual(['https://help.kusto.windows.net']);
  expect(KustoConnection).toHaveBeenCalled();
  await client.close();
});
