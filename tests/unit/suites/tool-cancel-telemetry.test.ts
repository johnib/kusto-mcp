/**
 * #366 — a query the client cancels (notifications/cancelled) or abandons by
 * disconnecting is the client's choice, not a tool failure. Telemetry records
 * it as status=cancelled: no ERROR span status, no error.type and no
 * kustomcp.tool.errors count. The response the handler returns is unchanged.
 *
 * Drives the real tool-call handler, KustoConnection and queries.executeQuery;
 * only the azure-kusto-data Client (mocked in setup.ts) is routed.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { metrics, SpanStatusCode } from '@opentelemetry/api';
import {
  AggregationTemporality,
  MeterProvider,
  MetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  InMemorySpanExporter,
  ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { Client as KustoClient } from 'azure-kusto-data';
import { KustoQueryCancelledError } from '../../../src/common/errors.js';
import { KustoConnection } from '../../../src/operations/kusto/connection.js';
import { executeQuery } from '../../../src/operations/kusto/queries.js';
import { createKustoServer } from '../../../src/server.js';
import { AuthenticationMethod } from '../../../src/types/config.js';

jest.mock('../../../src/common/version.js', () => ({ VERSION: '0.0.0-test' }));

const spans = new InMemorySpanExporter();
const tracerProvider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(spans)],
});

class TestMetricReader extends MetricReader {
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}
// Delta, so each collect() returns only what was recorded since the last one.
const reader = new TestMetricReader({
  aggregationTemporalitySelector: () => AggregationTemporality.DELTA,
});
const meterProvider = new MeterProvider({ readers: [reader] });

type Point = { attributes: Record<string, unknown>; value: unknown };

async function collectMetrics(): Promise<Map<string, Point[]>> {
  const { resourceMetrics } = await reader.collect();
  const out = new Map<string, Point[]>();
  for (const scope of resourceMetrics.scopeMetrics) {
    for (const metric of scope.metrics) {
      const name = metric.descriptor.name;
      out.set(name, [
        ...(out.get(name) ?? []),
        ...(metric.dataPoints as unknown as Point[]),
      ]);
    }
  }
  return out;
}

const points = (m: Map<string, Point[]>, name: string) =>
  (m.get(name) ?? []).filter(p => p.attributes.tool === 'execute-query');

const ok = { primaryResults: [{ name: 'r', columns: [], _rows: [] }] };
const CANCELLED_RESPONSE = {
  content: [
    {
      type: 'text',
      text: 'Kusto Query Cancelled: Query cancelled by the client',
    },
  ],
  isError: true,
};

/** Route the mocked Kusto client; the user query does what `query` says. */
function routeKusto(query: () => Promise<unknown>): string[] {
  const calls: string[] = [];
  jest
    .spyOn(KustoClient.prototype, 'execute')
    .mockImplementation(async (_db: string | null, q: string) => {
      calls.push(q);
      if (q === 'print now()') return ok as never;
      if (q.startsWith('.cancel query')) return ok as never;
      return query() as never;
    });
  return calls;
}

// The SDK drops the response of a cancelled request, so the client never
// sees it. Capture what the tools/call handler returns instead.
const toolResults: unknown[] = [];
function captureToolResults(): void {
  type Handler = (request: unknown, extra: unknown) => Promise<unknown>;
  const real = Server.prototype.setRequestHandler as unknown as (
    this: Server,
    schema: unknown,
    handler: Handler,
  ) => void;
  jest
    .spyOn(Server.prototype, 'setRequestHandler')
    .mockImplementation(function (this: Server, schema, handler) {
      const h = handler as unknown as Handler;
      if (schema !== CallToolRequestSchema) return real.call(this, schema, h);
      return real.call(this, schema, async (request, extra) => {
        const result = await h(request, extra);
        toolResults.push(result);
        return result;
      });
    });
}

async function connect() {
  const server = createKustoServer({
    authMethod: AuthenticationMethod.AzureCli,
    queryTimeout: 5000,
  });
  const client = new Client({ name: 'unit-test', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const init = await client.callTool({
    name: 'initialize-connection',
    arguments: { cluster_url: 'https://x.kusto.windows.net', database: 'd' },
  });
  expect(init.isError).toBeFalsy();
  return {
    server,
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Drop everything recorded so far (e.g. by initialize-connection). */
async function resetTelemetry(): Promise<void> {
  spans.reset();
  await collectMetrics();
  toolResults.length = 0;
}

async function waitFor(cond: () => boolean, ms = 1000) {
  const until = Date.now() + ms;
  while (!cond() && Date.now() < until) {
    await new Promise(r => setTimeout(r, 10));
  }
}

const finished = (name: string) =>
  spans.getFinishedSpans().filter(s => s.name === name);
const toolSpans = () => finished('mcp.tool/execute-query');
const hasException = (s: ReadableSpan) =>
  s.events.some(e => e.name === 'exception');

const runQuery = (client: Client, signal?: AbortSignal) =>
  client.callTool(
    { name: 'execute-query', arguments: { query: 'T | count' } },
    undefined,
    { signal },
  );

function expectQuerySpansNotFailed() {
  for (const name of ['executeQuery', 'kusto.query']) {
    const [s] = finished(name);
    expect(s).toBeDefined();
    expect(s.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(s.attributes['kustomcp.error.type']).toBeUndefined();
    expect(hasException(s)).toBe(false);
  }
  expect(finished('kusto.query')[0].attributes['kustomcp.outcome']).toBe(
    'cancelled_by_client',
  );
}

function expectCancelledToolSpan() {
  const [tool] = toolSpans();
  expect(tool).toBeDefined();
  expect(tool.status.code).toBe(SpanStatusCode.UNSET);
  expect(tool.attributes['kustomcp.tool.status']).toBe('cancelled');
  expect(tool.attributes['kustomcp.error.type']).toBeUndefined();
  expect(hasException(tool)).toBe(false);
}

async function expectCancelledMetrics() {
  const m = await collectMetrics();
  expect(
    points(m, 'kustomcp.tool.calls').map(p => [p.attributes.status, p.value]),
  ).toEqual([['cancelled', 1]]);
  expect(
    points(m, 'kustomcp.tool.duration').map(p => p.attributes.status),
  ).toEqual(['cancelled']);
  expect(points(m, 'kustomcp.tool.errors')).toEqual([]);
  expect(
    (m.get('kustomcp.queries.total') ?? []).map(p => p.attributes.outcome),
  ).toEqual(['cancelled_by_client']);
}

describe('client-cancelled queries are not tool errors (#366)', () => {
  beforeAll(() => {
    tracerProvider.register();
    metrics.setGlobalMeterProvider(meterProvider);
  });
  beforeEach(() => {
    spans.reset();
    toolResults.length = 0;
  });
  afterEach(() => jest.restoreAllMocks());

  test('notifications/cancelled: status=cancelled, no ERROR, no tool.errors', async () => {
    const calls = routeKusto(() => new Promise(() => {}));
    captureToolResults();
    const { client, close } = await connect();
    try {
      await resetTelemetry();
      const ac = new AbortController();
      const pending = runQuery(client, ac.signal);
      await waitFor(() => calls.some(q => q.startsWith('T | count')));
      ac.abort('user gave up');
      await expect(pending).rejects.toThrow();
      await waitFor(() => toolResults.length > 0);

      expect(toolResults).toEqual([CANCELLED_RESPONSE]);
      expectCancelledToolSpan();
      expectQuerySpansNotFailed();
      await expectCancelledMetrics();
    } finally {
      await close();
    }
  });

  test('client disconnect mid-query: status=cancelled, no ERROR, no tool.errors', async () => {
    const calls = routeKusto(() => new Promise(() => {}));
    captureToolResults();
    const { server, client } = await connect();
    try {
      await resetTelemetry();
      const pending = runQuery(client).catch(() => undefined);
      await waitFor(() => calls.some(q => q.startsWith('T | count')));
      // What shutdown does on stdin EOF (#333): close the server, which
      // aborts every in-flight handler.
      await server.close();
      await pending;
      await waitFor(() => toolResults.length > 0);

      expect(toolResults).toEqual([CANCELLED_RESPONSE]);
      expectCancelledToolSpan();
      expectQuerySpansNotFailed();
      await expectCancelledMetrics();
    } finally {
      await client.close();
    }
  });

  test('the query after a cancel reports retry_class=after_cancelled', async () => {
    const calls = routeKusto(() => new Promise(() => {}));
    const { client, close } = await connect();
    try {
      const ac = new AbortController();
      const pending = runQuery(client, ac.signal);
      await waitFor(() => calls.some(q => q.startsWith('T | count')));
      ac.abort();
      await expect(pending).rejects.toThrow();
      await waitFor(() => toolSpans().length > 0);

      jest.restoreAllMocks();
      routeKusto(async () => ok);
      spans.reset();
      expect((await runQuery(client)).isError).toBeFalsy();
      expect(toolSpans()[0].attributes['kustomcp.query.retry_class']).toBe(
        'after_cancelled',
      );
    } finally {
      await close();
    }
  });

  test('a request cancelled before the query starts: no ERROR on the query spans', async () => {
    const calls = routeKusto(async () => ok);
    const conn = new KustoConnection({
      authMethod: AuthenticationMethod.AzureCli,
      queryTimeout: 2000,
    });
    await conn.initialize('https://x.kusto.windows.net', 'd');
    await resetTelemetry();
    calls.length = 0;

    const ac = new AbortController();
    ac.abort();
    // The class survives queries.executeQuery, so the tool handler sees it.
    await expect(
      executeQuery(conn, 'T | count', ac.signal),
    ).rejects.toBeInstanceOf(KustoQueryCancelledError);

    expect(calls).toEqual([]);
    expectQuerySpansNotFailed();
  });

  test('a failing query is still a tool error', async () => {
    routeKusto(async () => {
      throw Object.assign(new Error("Semantic error: 'x' is not a column"), {
        response: { status: 400 },
      });
    });
    const { client, close } = await connect();
    try {
      await resetTelemetry();
      const r = await runQuery(client);
      expect(r.isError).toBe(true);

      const [tool] = toolSpans();
      expect(tool.status.code).toBe(SpanStatusCode.ERROR);
      expect(tool.attributes['kustomcp.tool.status']).toBe('error');
      expect(tool.attributes['kustomcp.error.type']).toBe('KustoQueryError');
      for (const name of ['executeQuery', 'kusto.query']) {
        expect(finished(name)[0].status.code).toBe(SpanStatusCode.ERROR);
      }

      const m = await collectMetrics();
      expect(
        points(m, 'kustomcp.tool.calls').map(p => [
          p.attributes.status,
          p.value,
        ]),
      ).toEqual([['error', 1]]);
      expect(
        points(m, 'kustomcp.tool.duration').map(p => p.attributes.status),
      ).toEqual(['error']);
      expect(
        points(m, 'kustomcp.tool.errors').map(p => [
          p.attributes.error_type,
          p.value,
        ]),
      ).toEqual([['KustoQueryError', 1]]);
    } finally {
      await close();
    }
  });

  test('a successful call reports status=ok on the span and the metrics', async () => {
    routeKusto(async () => ok);
    const { client, close } = await connect();
    try {
      // Every tool span carries the status, not just execute-query's.
      expect(
        finished('mcp.tool/initialize-connection')[0].attributes[
          'kustomcp.tool.status'
        ],
      ).toBe('ok');
      await resetTelemetry();

      expect((await runQuery(client)).isError).toBeFalsy();

      const [tool] = toolSpans();
      expect(tool.status.code).toBe(SpanStatusCode.OK);
      expect(tool.attributes['kustomcp.tool.status']).toBe('ok');
      expect(tool.attributes['kustomcp.error.type']).toBeUndefined();

      const m = await collectMetrics();
      expect(
        points(m, 'kustomcp.tool.calls').map(p => [
          p.attributes.status,
          p.value,
        ]),
      ).toEqual([['ok', 1]]);
      expect(
        points(m, 'kustomcp.tool.duration').map(p => p.attributes.status),
      ).toEqual(['ok']);
      expect(points(m, 'kustomcp.tool.errors')).toEqual([]);
    } finally {
      await close();
    }
  });
});
