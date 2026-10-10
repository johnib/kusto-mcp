/**
 * #312 — an execute-query timeout (ours or the server's) must tell the agent
 * how to recover (narrow the time range, filter earlier, summarize first), and
 * mention the lookback when the query's time window is longer than a day.
 * The show-* tools run fixed metadata queries (`.show tables`, `T | getschema`)
 * and management commands have no time range, so neither gets the advice. The
 * hint is for the agent only: it must never reach a span attribute or event.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { Client as KustoClient } from 'azure-kusto-data';
import { withTimeoutHint } from '../../../src/common/errors.js';
import { createKustoServer } from '../../../src/server.js';
import { AuthenticationMethod } from '../../../src/types/config.js';

jest.mock('../../../src/common/version.js', () => ({ VERSION: '0.0.0-test' }));

const HINT =
  'Narrow the time range, filter earlier, or summarize before returning rows.';
const LOOKBACK = 'looks back more than 1 day';

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

const ok = { primaryResults: [{ name: 'r', columns: [], _rows: [] }] };

const hang = () => new Promise(() => {});

const serverTimeout = async () => {
  throw Object.assign(new Error('Request failed with status code 400'), {
    response: {
      status: 400,
      data: {
        error: {
          code: 'RequestExecutionTimeout',
          '@type': 'Kusto.Data.Exceptions.KustoServiceTimeoutException',
          '@message': 'Query timed out',
        },
      },
    },
  });
};

/**
 * Call `tool` through the MCP server, with every Kusto request except the
 * connection probe behaving as `kusto` says; return the tool's error text.
 */
async function toolError(
  tool: string,
  args: Record<string, unknown>,
  kusto: () => Promise<unknown>,
  queryTimeout = 60000,
): Promise<string> {
  jest
    .spyOn(KustoClient.prototype, 'execute')
    .mockImplementation(
      async (_db: string | null, q: string) =>
        (q === 'print now()' ? ok : await kusto()) as never,
    );
  const server = createKustoServer({
    authMethod: AuthenticationMethod.AzureCli,
    queryTimeout,
  });
  const client = new Client({ name: 'unit-test', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    await client.callTool({
      name: 'initialize-connection',
      arguments: { cluster_url: 'https://x.kusto.windows.net', database: 'd' },
    });
    exporter.reset();
    const r = await client.callTool({ name: tool, arguments: args });
    expect(r.isError).toBe(true);
    return (r.content as { text: string }[])[0].text;
  } finally {
    await client.close();
    await server.close();
  }
}

const query = (q: string, kusto: () => Promise<unknown>, timeout?: number) =>
  toolError('execute-query', { query: q }, kusto, timeout);

const showTools: [string, Record<string, unknown>][] = [
  ['show-tables', {}],
  ['show-table', { tableName: 'StormEvents' }],
  ['show-functions', {}],
  ['show-function', { functionName: 'MyFunc' }],
];

describe('timeout recovery hint (#312)', () => {
  beforeAll(() => provider.register());
  beforeEach(() => exporter.reset());
  afterEach(() => jest.restoreAllMocks());

  test('client timeout on a short-window query gets the hint, no lookback note', async () => {
    const msg = await query(
      'StormEvents | where StartTime > ago(1h) | count',
      hang,
      20,
    );
    expect(msg).toBe(`Kusto Timeout Error: Query timed out after 20ms. ${HINT}`);
  });

  test('client timeout on a query with no time filter still gets the hint', async () => {
    const msg = await query('StormEvents | count', hang, 20);
    expect(msg).toContain(HINT);
    expect(msg).not.toContain(LOOKBACK);
  });

  test('a lookback longer than a day is called out', async () => {
    const msg = await query(
      'StormEvents | where StartTime > ago(30d) | take 10',
      hang,
      20,
    );
    expect(msg).toContain(HINT);
    expect(msg).toContain(LOOKBACK);
  });

  test('a one-day lookback is not called out', async () => {
    const msg = await query(
      'StormEvents | where StartTime > ago(1d) | take 10',
      hang,
      20,
    );
    expect(msg).toContain(HINT);
    expect(msg).not.toContain(LOOKBACK);
  });

  test('server timeout gets the hint and the lookback note', async () => {
    const msg = await query(
      'StormEvents | where StartTime > ago(7d) | take 10',
      serverTimeout,
    );
    expect(msg).toBe(
      `Kusto Timeout Error: Query timed out. ${HINT} The query ${LOOKBACK}; try a shorter window first.`,
    );
  });

  test('an HTTP (ECONNABORTED) timeout gets the hint', async () => {
    const msg = await query(
      'StormEvents | where StartTime > ago(30d) | take 10',
      async () => {
        throw Object.assign(new Error('timeout of 90000ms exceeded'), {
          code: 'ECONNABORTED',
        });
      },
    );
    expect(msg).toBe(
      `Kusto Timeout Error: timeout of 90000ms exceeded. ${HINT} The query ${LOOKBACK}; try a shorter window first.`,
    );
  });

  test('a management command timeout gets no time-range advice', async () => {
    const msg = await query('.show tables', hang, 20);
    expect(msg).toBe('Kusto Timeout Error: Query timed out after 20ms');
  });

  test('a management command server timeout gets no time-range advice', async () => {
    const msg = await query('.show table StormEvents details', serverTimeout);
    expect(msg).toBe('Kusto Timeout Error: Query timed out');
  });

  test.each(showTools)('%s client timeout gets no hint', async (tool, args) => {
    const msg = await toolError(tool, args, hang, 20);
    expect(msg).toBe('Kusto Timeout Error: Query timed out after 20ms');
  });

  test.each(showTools)('%s server timeout gets no hint', async (tool, args) => {
    const msg = await toolError(tool, args, serverTimeout);
    expect(msg).toBe('Kusto Timeout Error: Query timed out');
  });

  test('a management command too large to classify gets no hint', () => {
    // classifyQueryShape returns 'unparsed' above 64 KiB.
    const command = `.ingest inline into table T <| ${'a,'.repeat(40_000)}`;
    expect(withTimeoutHint('Query timed out', command)).toBe('Query timed out');
    expect(withTimeoutHint('Query timed out', `  \n${command}`)).toBe(
      'Query timed out',
    );
  });

  test('a query too large to classify still gets the hint', () => {
    const query = `T | where x in (${'1,'.repeat(40_000)}1)`;
    expect(withTimeoutHint('Query timed out', query)).toBe(
      `Query timed out. ${HINT}`,
    );
  });

  test('non-timeout errors get no hint', async () => {
    const msg = await query('StormEvents | where ago(30d)', async () => {
      throw new Error('Semantic error');
    });
    expect(msg).not.toContain(HINT);
  });

  test('the hint never reaches telemetry', async () => {
    const msg = await query(
      'StormEvents | where StartTime > ago(30d) | take 10',
      hang,
      20,
    );
    expect(msg).toContain(HINT);

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThan(0);
    const dumped = JSON.stringify(
      spans.map(s => ({
        attributes: s.attributes,
        events: s.events,
        status: s.status,
      })),
    );
    expect(dumped).not.toMatch(/narrow|summarize|looks back/i);
  });

  test('a long server message is handled in linear time', () => {
    // A trailing-punctuation regex like /\.?\s*$/ is quadratic on long
    // whitespace runs; this input took ~20s with it.
    const started = Date.now();
    const msg = withTimeoutHint(' '.repeat(200_000) + 'x', 'T | count');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(msg.endsWith(`x. ${HINT}`)).toBe(true);
  });

  test('trailing period and whitespace are not doubled', () => {
    expect(withTimeoutHint('Query timed out. \n', 'T')).toBe(
      `Query timed out. ${HINT}`,
    );
  });
});
