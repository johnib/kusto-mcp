/**
 * #294 — KUSTO_QUERY_TIMEOUT must reach the server. Without request
 * properties the server applies its own default (~4 min) and keeps running the
 * query after our client-side timer fires. executeQuery now passes
 * ClientRequestProperties with servertimeout = queryTimeout (clamped to
 * Kusto's 1h max) and an HTTP client timeout slightly above it.
 */

jest.mock('azure-kusto-data', () => ({
  Client: jest.fn(),
  KustoConnectionStringBuilder: {
    withAzLoginIdentity: jest.fn(u => `cs-${u}`),
    withTokenCredential: jest.fn(u => `cs-${u}`),
  },
  // Mirrors the azure-kusto-data 7.2.0 API surface used by connection.ts.
  ClientRequestProperties: class {
    serverTimeout?: number;
    clientTimeout?: number;
    setTimeout(ms: number) {
      this.serverTimeout = ms;
    }
    getTimeout() {
      return this.serverTimeout;
    }
    setClientTimeout(ms: number) {
      this.clientTimeout = ms;
    }
    getClientTimeout() {
      return this.clientTimeout;
    }
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

import { KustoConnection } from '../../../src/operations/kusto/connection.js';
import { AuthenticationMethod } from '../../../src/types/config.js';

async function propsForQuery(queryTimeout?: number) {
  const { Client } = require('azure-kusto-data');
  const mockExecute = jest
    .fn()
    .mockResolvedValue({ primaryResults: [{ data: [] }] });
  Client.mockImplementation(() => ({ execute: mockExecute }));

  const conn = new KustoConnection({
    authMethod: AuthenticationMethod.AzureCli,
    queryTimeout,
  });
  await conn.initialize('https://help.kusto.windows.net', 'Samples');
  mockExecute.mockClear();

  await conn.executeQuery('Samples', 'StormEvents | take 1');
  expect(mockExecute).toHaveBeenCalledTimes(1);
  const [db, query, props] = mockExecute.mock.calls[0];
  expect(db).toBe('Samples');
  expect(query).toBe('StormEvents | take 1');
  expect(props).toBeDefined();
  return props;
}

describe('executeQuery sends the query timeout to the server (#294)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('servertimeout = queryTimeout, client timeout = queryTimeout + 30s', async () => {
    const props = await propsForQuery(120000);
    expect(props.getTimeout()).toBe(120000);
    expect(props.getClientTimeout()).toBe(150000);
  });

  test('default queryTimeout (120s) is sent when unset', async () => {
    const props = await propsForQuery(undefined);
    expect(props.getTimeout()).toBe(120000);
    expect(props.getClientTimeout()).toBe(150000);
  });

  test('servertimeout is clamped to the 1h Kusto maximum', async () => {
    const props = await propsForQuery(2 * 3600000);
    expect(props.getTimeout()).toBe(3600000);
    expect(props.getClientTimeout()).toBe(2 * 3600000 + 30000);
  });
});
