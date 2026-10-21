/**
 * kustomcp.connection.target_changed: a bounded boolean on mcp.connection.init
 * saying whether this connect points somewhere other than the connection the
 * server is using. Absent when none is in use. The cluster and database never
 * ship, raw or hashed.
 */

import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

jest.mock('azure-kusto-data', () => ({
  Client: jest.fn(),
  KustoConnectionStringBuilder: {
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

import { KustoConnection } from '../../../src/operations/kusto/connection.js';
import { AuthenticationMethod } from '../../../src/types/config.js';

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

const KEY = 'kustomcp.connection.target_changed';

describe('connection target_changed', () => {
  const { Client } = require('azure-kusto-data');
  let fail = false;

  beforeAll(() => {
    provider.register();
    Client.mockImplementation(() => ({
      execute: jest.fn(() =>
        fail
          ? Promise.reject(new Error('boom'))
          : Promise.resolve({ primaryResults: [{ data: [] }] }),
      ),
      close: jest.fn(),
    }));
  });

  async function connect(
    cluster: string,
    db: string,
    inUse?: KustoConnection,
  ) {
    exporter.reset();
    const c = new KustoConnection({
      authMethod: AuthenticationMethod.AzureCli,
      connectionTimeout: 2000,
    });
    await c.initialize(cluster, db, 'manual', inUse).catch(() => undefined);
    const span = exporter
      .getFinishedSpans()
      .find(s => s.name === 'mcp.connection.init');
    return { c, attrs: span!.attributes };
  }

  test('absent without a connection in use, else true only on a change', async () => {
    const { c: inUse, attrs: a1 } = await connect(
      'https://secretcluster.kusto.windows.net',
      'DbA',
    );
    expect(a1).not.toHaveProperty(KEY);

    // Same target, modulo case (ADX names are case-insensitive) and a
    // trailing slash on the URL.
    const { attrs: a2 } = await connect(
      'https://SecretCluster.kusto.windows.net/',
      'dba',
      inUse,
    );
    expect(a2[KEY]).toBe(false);

    const { attrs: a3 } = await connect(
      'https://secretcluster.kusto.windows.net',
      'DbB',
      inUse,
    );
    expect(a3[KEY]).toBe(true);

    // A connect that succeeded but was never put in use (the server discarded
    // it) does not become the baseline.
    const { attrs: a4 } = await connect(
      'https://other.kusto.windows.net',
      'DbB',
      inUse,
    );
    expect(a4[KEY]).toBe(true);
    const { attrs: a5 } = await connect(
      'https://secretcluster.kusto.windows.net',
      'DbA',
      inUse,
    );
    expect(a5[KEY]).toBe(false);

    // A failed connect does not carry it, nor count as a connection in use.
    fail = true;
    const { c: failed, attrs: a6 } = await connect(
      'https://third.kusto.windows.net',
      'DbC',
      inUse,
    );
    expect(a6[KEY]).toBeUndefined();
    fail = false;
    const { attrs: a7 } = await connect(
      'https://other.kusto.windows.net',
      'DbB',
      failed,
    );
    expect(a7).not.toHaveProperty(KEY);

    // Neither the cluster nor the database is exported.
    for (const attrs of [a1, a2, a3, a4, a5, a6, a7]) {
      const out = JSON.stringify(attrs).toLowerCase();
      for (const s of ['secretcluster', 'other.kusto', 'third', 'dba', 'dbb']) {
        expect(out).not.toContain(s);
      }
    }
  });
});
