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

  test('a successful init stamps cloud, source, outcome=success and duration', async () => {
    const { Client } = require('azure-kusto-data');
    const mockExecute = jest.fn().mockResolvedValue({
      primaryResults: [{ data: [{ now: '2026-01-01T00:00:00Z' }] }],
    });
    Client.mockImplementation(() => ({ execute: mockExecute }));

    const connection = new KustoConnection({
      authMethod: AuthenticationMethod.AzureCli,
    });
    await connection.initialize(
      'https://help.kusto.windows.net',
      'Samples',
      'auto',
    );

    const initSpan = exporter
      .getFinishedSpans()
      .find(s => s.name === 'mcp.connection.init');
    const attrs = initSpan!.attributes;
    expect(attrs['kustomcp.connection.source']).toBe('auto');
    expect(attrs['kustomcp.cloud']).toBe('public');
    expect(attrs['kustomcp.connection.outcome']).toBe('success');
    expect(attrs['kustomcp.connection.timed_out']).toBe(false);
    expect(typeof attrs['kustomcp.connection.duration_ms']).toBe('number');
    // proxy_configured is a boolean, never the proxy value.
    expect(typeof attrs['kustomcp.proxy_configured']).toBe('boolean');
  });

  test('classifyCloud maps sovereign-cloud host suffixes without leaking the cluster name', async () => {
    const { Client } = require('azure-kusto-data');
    Client.mockImplementation(() => ({
      execute: jest.fn().mockResolvedValue({ primaryResults: [{ data: [] }] }),
    }));

    const cases: Array<[string, string]> = [
      ['https://acme.kusto.usgovcloudapi.net', 'usgov'],
      ['https://acme.kusto.chinacloudapi.cn', 'china'],
      ['https://acme.example.com', 'other'],
    ];
    for (const [url, expected] of cases) {
      exporter.reset();
      const conn = new KustoConnection({
        authMethod: AuthenticationMethod.AzureCli,
      });
      await conn.initialize(url, 'db');
      const span = exporter
        .getFinishedSpans()
        .find(s => s.name === 'mcp.connection.init');
      expect(span?.attributes['kustomcp.cloud']).toBe(expected);
      // The org-specific subdomain never appears as an attribute value.
      for (const v of Object.values(span!.attributes)) {
        if (typeof v === 'string') expect(v).not.toContain('acme');
      }
    }
  });

  test('failure classification unwraps the axios .cause chain and HTTP status', async () => {
    const { Client } = require('azure-kusto-data');
    const cases: Array<[Record<string, unknown>, string]> = [
      // axios rewrites top-level code to ERR_NETWORK but nests the real cause.
      [
        {
          name: 'AxiosError',
          code: 'ERR_NETWORK',
          cause: { code: 'ECONNREFUSED' },
        },
        'connection_refused',
      ],
      [{ name: 'AxiosError', cause: { code: 'ENOTFOUND' } }, 'dns_resolution'],
      // HTTP status carried on response even when code is an axios wrapper.
      [
        {
          name: 'AxiosError',
          code: 'ERR_BAD_REQUEST',
          response: { status: 403 },
        },
        'authz',
      ],
      [{ code: 'ERR_NETWORK' }, 'network'],
    ];
    for (const [shape, expected] of cases) {
      exporter.reset();
      const err = Object.assign(new Error('boom'), shape);
      Client.mockImplementation(() => ({
        execute: jest.fn().mockRejectedValue(err),
      }));
      const conn = new KustoConnection({
        authMethod: AuthenticationMethod.AzureCli,
      });
      await expect(
        conn.initialize('https://help.kusto.windows.net', 'db'),
      ).rejects.toThrow();
      const span = exporter
        .getFinishedSpans()
        .find(s => s.name === 'mcp.connection.init');
      expect(span?.attributes['kustomcp.connection.failure_category']).toBe(
        expected,
      );
    }
  });
});
