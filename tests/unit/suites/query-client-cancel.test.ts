/**
 * #320 — when the MCP host cancels an in-flight execute-query
 * (notifications/cancelled), we stop waiting, send a best-effort
 * `.cancel query "<ClientRequestId>"` for the running query, and record
 * kustomcp.outcome=cancelled_by_client on the query span.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { Client as KustoClient } from 'azure-kusto-data';
import { KustoQueryCancelledError } from '../../../src/common/errors.js';
import { KustoConnection } from '../../../src/operations/kusto/connection.js';
import { createKustoServer } from '../../../src/server.js';
import { AuthenticationMethod } from '../../../src/types/config.js';

jest.mock('../../../src/common/version.js', () => ({ VERSION: '0.0.0-test' }));

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

type Call = { query: string; props?: { clientRequestId?: string | null } };

const ok = { primaryResults: [{ name: 'r', columns: [], _rows: [] }] };

/**
 * Route the mocked Kusto client: the connection probe and `.cancel query`
 * succeed (or `.cancel` fails, when asked); the user query does what `query`
 * says.
 */
function routeKusto(
  query: () => Promise<unknown>,
  cancel: () => Promise<unknown> = async () => ok,
) {
  const calls: Call[] = [];
  jest
    .spyOn(KustoClient.prototype, 'execute')
    .mockImplementation(async (_db: string | null, q: string, props?: unknown) => {
      calls.push({ query: q, props: props as Call['props'] });
      if (q === 'print now()') return ok as never;
      if (q.startsWith('.cancel query')) return cancel() as never;
      return query() as never;
    });
  return calls;
}

async function connect() {
  const server = createKustoServer({
    authMethod: AuthenticationMethod.AzureCli,
    queryTimeout: 2000,
  });
  const client = new Client({ name: 'unit-test', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  await client.callTool({
    name: 'initialize-connection',
    arguments: { cluster_url: 'https://x.kusto.windows.net', database: 'd' },
  });
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function waitFor(cond: () => boolean, ms = 1000) {
  const until = Date.now() + ms;
  while (!cond() && Date.now() < until) {
    await new Promise(r => setTimeout(r, 10));
  }
}

const querySpans = () =>
  exporter.getFinishedSpans().filter(s => s.name === 'kusto.query');

describe('execute-query client cancellation (#320)', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);

  beforeAll(() => {
    provider.register();
    process.on('unhandledRejection', onUnhandled);
  });
  afterAll(() => {
    process.off('unhandledRejection', onUnhandled);
  });
  beforeEach(() => {
    exporter.reset();
    unhandled.length = 0;
  });
  afterEach(() => jest.restoreAllMocks());

  test('client cancel sends .cancel query for our ClientRequestId and records the outcome', async () => {
    const calls = routeKusto(() => new Promise(() => {}));
    const { client, close } = await connect();
    try {
      exporter.reset();
      const ac = new AbortController();
      const pending = client.callTool(
        { name: 'execute-query', arguments: { query: 'T | count' } },
        undefined,
        { signal: ac.signal },
      );
      await waitFor(() => calls.some(c => c.query.startsWith('T | count')));
      ac.abort('user gave up');
      await expect(pending).rejects.toThrow();

      await waitFor(() => querySpans().length > 0 && calls.length >= 3);

      const queryCall = calls.find(c => c.query.startsWith('T | count'))!;
      const requestId = queryCall.props?.clientRequestId;
      expect(typeof requestId).toBe('string');
      expect(requestId).toMatch(/^[A-Za-z0-9.;-]+$/);

      const cancelCall = calls.find(c => c.query.startsWith('.cancel query'));
      expect(cancelCall?.query).toBe(`.cancel query "${requestId}"`);

      const [span] = querySpans();
      expect(span.attributes['kustomcp.outcome']).toBe('cancelled_by_client');
      expect(span.attributes['kustomcp.query.timeout_kind']).toBeUndefined();
      expect(span.attributes['kustomcp.error.type']).toBe(
        'KustoQueryCancelledError',
      );
    } finally {
      await close();
    }
  });

  test('a failing .cancel query never surfaces as an unhandled rejection', async () => {
    const calls = routeKusto(
      () => new Promise(() => {}),
      async () => {
        throw new Error('cancel failed');
      },
    );
    const { client, close } = await connect();
    try {
      const ac = new AbortController();
      const pending = client.callTool(
        { name: 'execute-query', arguments: { query: 'T | count' } },
        undefined,
        { signal: ac.signal },
      );
      await waitFor(() => calls.some(c => c.query.startsWith('T | count')));
      ac.abort();
      await expect(pending).rejects.toThrow();
      await waitFor(() => calls.some(c => c.query.startsWith('.cancel query')));
      await new Promise(r => setTimeout(r, 50));

      expect(calls.some(c => c.query.startsWith('.cancel query'))).toBe(true);
      expect(unhandled).toEqual([]);
    } finally {
      await close();
    }
  });

  test('a request cancelled before the query starts never sends the query', async () => {
    const calls = routeKusto(async () => ok);
    const conn = new KustoConnection({
      authMethod: AuthenticationMethod.AzureCli,
      queryTimeout: 2000,
    });
    await conn.initialize('https://x.kusto.windows.net', 'd');
    exporter.reset();
    calls.length = 0;

    const ac = new AbortController();
    ac.abort();
    await expect(
      conn.executeQuery('d', 'T | count', ac.signal),
    ).rejects.toBeInstanceOf(KustoQueryCancelledError);

    expect(calls).toEqual([]);
    expect(querySpans()[0].attributes['kustomcp.outcome']).toBe(
      'cancelled_by_client',
    );
  });

  test('a completed query sends no .cancel query', async () => {
    const calls = routeKusto(async () => ok);
    const { client, close } = await connect();
    try {
      exporter.reset();
      const r = await client.callTool({
        name: 'execute-query',
        arguments: { query: 'T | count' },
      });
      expect(r.isError).toBeFalsy();
      await new Promise(r => setTimeout(r, 50));
      expect(calls.some(c => c.query.startsWith('.cancel query'))).toBe(false);
      expect(querySpans()[0].attributes['kustomcp.outcome']).toBe('success');
    } finally {
      await close();
    }
  });
});
