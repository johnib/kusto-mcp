/**
 * execute-query delivery: the empty-result hint, and span attributes for what
 * the agent actually received after response limiting.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { createKustoServer } from '../../../src/server.js';
import { KustoConfig, ResponseFormat } from '../../../src/types/config.js';
import { executeQuery } from '../../../src/operations/kusto/index.js';

jest.mock('../../../src/common/version.js', () => ({ VERSION: '0.0.0-test' }));

jest.mock('../../../src/operations/kusto/index.js', () => {
  const actual = jest.requireActual('../../../src/operations/kusto/index.js');
  return {
    ...actual,
    KustoConnection: jest.fn().mockImplementation(() => ({
      initialize: async () => ({ cluster: 'c', database: 'd' }),
    })),
    executeQuery: jest.fn(),
  };
});

const mockedExecute = executeQuery as jest.MockedFunction<typeof executeQuery>;

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

const HINT = 'No rows matched. If this is unexpected, check the datetime()';

function rows(values: unknown[][]) {
  return {
    primaryResults: [
      {
        name: 'r',
        columns: [{ ColumnName: 'a' }, { ColumnName: 'b' }],
        _rows: values,
      },
    ],
  } as unknown as Awaited<ReturnType<typeof executeQuery>>;
}

async function run(
  result: ReturnType<typeof rows>,
  config: KustoConfig = {},
): Promise<{ text: string; attrs: Record<string, unknown> }> {
  exporter.reset();
  mockedExecute.mockResolvedValue(result);
  const server = createKustoServer(config);
  const client = new Client({ name: 'unit-test', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    await client.callTool({
      name: 'initialize-connection',
      arguments: { cluster_url: 'https://x.kusto.windows.net', database: 'd' },
    });
    const res = await client.callTool({
      name: 'execute-query',
      arguments: { query: 'T | take 10' },
    });
    expect(res.isError).toBeFalsy();
    const text = (res.content as Array<{ text: string }>)[0].text;
    const span = exporter
      .getFinishedSpans()
      .find(s => s.name === 'mcp.tool/execute-query')!;
    return { text, attrs: span.attributes };
  } finally {
    await client.close();
    await server.close();
  }
}

describe('execute-query result delivery', () => {
  beforeAll(() => provider.register());

  test.each([ResponseFormat.Json, ResponseFormat.Markdown])(
    '%s: zero rows appends the empty-result hint',
    async responseFormat => {
      const { text, attrs } = await run(rows([]), { responseFormat });
      expect(text).toContain(HINT);
      expect(attrs['kustomcp.result.row_count']).toBe(0);
      expect(attrs['kustomcp.result.delivered_row_count']).toBe(0);
    },
  );

  test.each([ResponseFormat.Json, ResponseFormat.Markdown])(
    '%s: rows returned means no empty-result hint',
    async responseFormat => {
      const { text } = await run(
        rows([
          [1, 'x'],
          [2, 'y'],
        ]),
        { responseFormat },
      );
      expect(text).not.toContain('No rows matched');
    },
  );

  test('stamps delivered rows and chars against the cap', async () => {
    const { text, attrs } = await run(
      rows([
        [1, 'x'],
        [2, 'y'],
      ]),
    );
    expect(attrs['kustomcp.result.row_count']).toBe(2);
    expect(attrs['kustomcp.result.delivered_row_count']).toBe(2);
    expect(attrs['kustomcp.response.chars']).toBe(text.length);
    expect(attrs['kustomcp.response.max_chars']).toBe(12000);
    expect(attrs['kustomcp.response.bytes']).toEqual(expect.any(Number));
  });

  test('trimmed rows: delivered count is post-trim, row_count pre-trim', async () => {
    const many = Array.from({ length: 10 }, (_, i) => [i, 'z'.repeat(400)]);
    const { text, attrs } = await run(rows(many), { maxResponseLength: 2000 });
    expect(attrs['kustomcp.result.row_count']).toBe(10);
    const delivered = attrs['kustomcp.result.delivered_row_count'] as number;
    expect(delivered).toBeGreaterThanOrEqual(1);
    expect(delivered).toBeLessThan(10);
    expect(attrs['kustomcp.response.chars']).toBe(text.length);
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(attrs['kustomcp.response.max_chars']).toBe(2000);
    expect(attrs['kustomcp.response.was_reduced']).toBe(true);
  });

  test('one giant row is cut to fit the cap', async () => {
    const { text, attrs } = await run(rows([[1, 'g'.repeat(100_000)]]));
    expect(text.length).toBeLessThanOrEqual(12000);
    expect(text).toMatch(/…\[truncated \d+ chars\]/);
    expect(attrs['kustomcp.result.delivered_row_count']).toBe(1);
    expect(attrs['kustomcp.response.chars']).toBe(text.length);
    expect(attrs['kustomcp.response.was_reduced']).toBe(true);
  });
});
