/**
 * I5 — connection-init timeout. Without a bound, a hung auth or unreachable
 * cluster inherits azure-kusto-data's 270s query default (verified in
 * client.js: QUERY_TIMEOUT_IN_MILLISECS = 4m30s). initialize() now races the
 * whole critical section against `connectionTimeout`, so it fails fast and the
 * failure is classified as a timeout.
 */

import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

jest.mock('azure-kusto-data', () => ({
  Client: jest.fn(),
  KustoConnectionStringBuilder: {
    withAzLoginIdentity: jest.fn(u => `cs-${u}`),
    withTokenCredential: jest.fn(u => `cs-${u}`),
  },
  ClientRequestProperties: class {
    setClientTimeout() {
      /* no-op for tests */
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

// eslint-disable-next-line @typescript-eslint/no-var-requires
import { KustoConnection } from '../../../src/operations/kusto/connection.js';
import {
  AuthenticationMethod,
  KustoConfig,
} from '../../../src/types/config.js';

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

describe('connection init is bounded by connectionTimeout (I5)', () => {
  beforeAll(() => {
    provider.register();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    exporter.reset();
  });

  test('a hung init rejects at connectionTimeout and classifies failure_category=timeout', async () => {
    const { Client } = require('azure-kusto-data');
    // execute never resolves → the deadline must fire.
    const mockExecute = jest.fn(() => new Promise(() => {}));
    Client.mockImplementation(() => ({ execute: mockExecute }));

    const config: KustoConfig = {
      authMethod: AuthenticationMethod.AzureCli,
      connectionTimeout: 50,
    };
    const connection = new KustoConnection(config);

    const start = Date.now();
    await expect(
      connection.initialize('https://help.kusto.windows.net', 'Samples'),
    ).rejects.toThrow(/timed out/i);

    // Fails fast — nowhere near the 270s library default.
    expect(Date.now() - start).toBeLessThan(2000);
    expect(connection.isInitialized()).toBe(false);

    const initSpan = exporter
      .getFinishedSpans()
      .find(s => s.name === 'mcp.connection.init');
    expect(initSpan?.attributes['kustomcp.connection.failure_category']).toBe(
      'timeout',
    );
  });
});
