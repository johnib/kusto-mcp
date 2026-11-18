/**
 * #295 — debug-only serialization must be lazy. debugLog used to receive a
 * pre-built string, so `JSON.stringify(rawResult, null, 2)` ran on every query
 * even with DEBUG_SERVER unset. JSON.stringify calls toJSON() on each value it
 * serializes, so a toJSON spy on the response shows whether serialization ran.
 */

jest.mock('azure-kusto-data', () => ({
  CloudSettings: {
    getCloudInfoForCluster: async () => ({
      KustoServiceResourceId: 'https://kusto.kusto.windows.net',
      LoginMfaRequired: false,
    }),
  },
  Client: jest.fn(),
  KustoConnectionStringBuilder: {
    withAzLoginIdentity: jest.fn(u => `cs-${u}`),
    withTokenCredential: jest.fn(u => `cs-${u}`),
  },
  ClientRequestProperties: class {
    setTimeout() {}
    setClientTimeout() {}
  },
}));

jest.mock('../../../src/auth/token-credentials.js', () => ({
  createTokenCredential: jest.fn(() => ({
    getToken: jest.fn().mockResolvedValue({
      token: 'mock-token',
      expiresOnTimestamp: Date.now() + 3600000,
    }),
  })),
}));

import { debugLog } from '../../../src/common/utils.js';
import { KustoConnection } from '../../../src/operations/kusto/connection.js';
import { transformQueryResult } from '../../../src/operations/kusto/queries.js';
import { KustoQueryResult } from '../../../src/types/kusto-interfaces.js';
import { AuthenticationMethod } from '../../../src/types/config.js';

async function runQuery(response: unknown) {
  const { Client } = require('azure-kusto-data');
  Client.mockImplementation(() => ({
    execute: jest.fn().mockResolvedValue(response),
  }));
  const conn = new KustoConnection({
    authMethod: AuthenticationMethod.AzureCli,
  });
  await conn.initialize('https://help.kusto.windows.net', 'Samples');
  await conn.executeQuery('Samples', 'StormEvents | take 1');
}

describe('debug-only serialization is lazy (#295)', () => {
  const original = process.env.DEBUG_SERVER;
  let stderrSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    stderrSpy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    if (original === undefined) delete process.env.DEBUG_SERVER;
    else process.env.DEBUG_SERVER = original;
  });

  test('executeQuery does not serialize the raw response with debug off', async () => {
    delete process.env.DEBUG_SERVER;
    const toJSON = jest.fn(() => ({}));
    await runQuery({ primaryResults: [], toJSON });
    expect(toJSON).not.toHaveBeenCalled();
  });

  test('executeQuery still logs the raw response with DEBUG_SERVER=1', async () => {
    process.env.DEBUG_SERVER = '1';
    const toJSON = jest.fn(() => ({ marker: 'raw-response' }));
    await runQuery({ primaryResults: [], toJSON });
    expect(toJSON).toHaveBeenCalled();
    const logged = stderrSpy.mock.calls.map(c => String(c[0])).join('');
    expect(logged).toContain('Raw Kusto Response:');
    expect(logged).toContain('raw-response');
  });

  test('transformQueryResult does not serialize columns with debug off', () => {
    delete process.env.DEBUG_SERVER;
    const toJSON = jest.fn(() => ({}));
    const column = { name: 'A', type: 'string', toJSON };
    transformQueryResult({
      primaryResults: [{ columns: [column], _rows: [['x']] }],
    } as unknown as KustoQueryResult);
    expect(toJSON).not.toHaveBeenCalled();
  });

  test('debugLog does not call a message function with debug off', () => {
    delete process.env.DEBUG_SERVER;
    const build = jest.fn(() => 'expensive');
    debugLog(build);
    expect(build).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  test('debugLog writes a message function result with DEBUG_SERVER=1', () => {
    process.env.DEBUG_SERVER = '1';
    debugLog(() => 'expensive');
    expect(stderrSpy).toHaveBeenCalledWith('expensive\n');
  });
});
