/**
 * Wiring test: the execute-query tool span carries the declared purpose, query
 * shape and session-behavior attributes — and never the query text.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { createKustoServer } from '../../../src/server.js';
import { KustoConfig } from '../../../src/types/config.js';
import { executeQuery } from '../../../src/operations/kusto/index.js';

jest.mock('../../../src/common/version.js', () => ({ VERSION: '0.0.0-test' }));

jest.mock('../../../src/operations/kusto/index.js', () => {
  const actual = jest.requireActual('../../../src/operations/kusto/index.js');
  return {
    ...actual,
    KustoConnection: jest.fn().mockImplementation(() => ({
      initialize: async () => ({ cluster: 'c', database: 'd' }),
    })),
    executeQuery: jest.fn(async () => ({
      primaryResults: [
        { name: 'r', columns: [{ ColumnName: 'a' }], _rows: [[1], [2]] },
      ],
    })),
  };
});

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

const SECRET_QUERY =
  'AcmeSecretTable | where Pw == "p@ssw0rd-DO-NOT-LEAK" and t > ago(2d) | summarize count() by Region';

async function connect(config: KustoConfig = {}) {
  const server = createKustoServer(config);
  const client = new Client({ name: 'unit-test', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

const toolSpans = () =>
  exporter.getFinishedSpans().filter(s => s.name === 'mcp.tool/execute-query');

describe('execute-query intent/shape/session telemetry', () => {
  beforeAll(() => provider.register());
  beforeEach(() => exporter.reset());

  test('stamps bounded attributes and never the query text', async () => {
    const { client, close } = await connect();
    try {
      await client.callTool({
        name: 'initialize-connection',
        arguments: {
          cluster_url: 'https://x.kusto.windows.net',
          database: 'd',
        },
      });
      // The mocked connection can't list tables, so this call errors; it still
      // counts as a schema lookup for the session signals.
      await client.callTool({ name: 'show-tables', arguments: {} });

      const r1 = await client.callTool({
        name: 'execute-query',
        arguments: { purpose: 'bulk_extract', query: SECRET_QUERY, limit: 10 },
      });
      expect(r1.isError).toBeFalsy();

      // A free-text purpose must not fail the call; it is captured as sent.
      const r2 = await client.callTool({
        name: 'execute-query',
        arguments: {
          purpose: 'SELECT secrets FROM customers',
          query: SECRET_QUERY,
          limit: 50,
        },
      });
      expect(r2.isError).toBeFalsy();

      // An unlisted but identifier-shaped label is captured for discovery.
      const r3 = await client.callTool({
        name: 'execute-query',
        arguments: { purpose: 'fraud_review', query: 'T | take 1' },
      });
      expect(r3.isError).toBeFalsy();

      // The tool schema must not constrain purpose (no enum) — never interfere.
      const { tools } = await client.listTools();
      const props = (
        tools.find(t => t.name === 'execute-query')!.inputSchema as {
          properties: Record<string, { type?: string; enum?: unknown }>;
        }
      ).properties;
      expect(props.purpose.type).toBe('string');
      expect(props.purpose.enum).toBeUndefined();

      const [first, second, third] = toolSpans();
      const a1 = first.attributes;
      expect(a1['kustomcp.declared.purpose']).toBe('bulk_extract');
      expect(a1['kustomcp.query.stmt_kind']).toBe('query');
      expect(a1['kustomcp.query.operators']).toEqual(['summarize', 'where']);
      expect(a1['kustomcp.query.time_window']).toBe('<=7d');
      expect(a1['kustomcp.session.prev_tool']).toBe('show-tables');
      expect(a1['kustomcp.session.query_ordinal']).toBe('1');
      expect(a1['kustomcp.session.schema_calls_before_query']).toBe('1');
      expect(a1['kustomcp.query.retry_class']).toBe('first');

      const a2 = second.attributes;
      expect(a2['kustomcp.declared.purpose']).toBe('other');
      expect(a2['kustomcp.declared.purpose_unlisted']).toBe(
        'SELECT secrets FROM customers',
      );
      expect(a2['kustomcp.session.prev_tool']).toBe('execute-query');
      expect(a2['kustomcp.session.query_ordinal']).toBe('2');
      expect(a2['kustomcp.query.retry_class']).toBe('after_success');
      expect(a2['kustomcp.query.limit_escalation']).toBe('raised');

      expect(third.attributes['kustomcp.declared.purpose']).toBe('other');
      expect(third.attributes['kustomcp.declared.purpose_unlisted']).toBe(
        'fraud_review',
      );

      for (const span of exporter.getFinishedSpans()) {
        const dump = JSON.stringify(span.attributes);
        expect(dump).not.toContain('AcmeSecretTable');
        expect(dump).not.toContain('p@ssw0rd');
      }
    } finally {
      await close();
    }
  });
  test('a failed query still records its limit for the next escalation check', async () => {
    const { client, close } = await connect();
    try {
      await client.callTool({
        name: 'initialize-connection',
        arguments: {
          cluster_url: 'https://x.kusto.windows.net',
          database: 'd',
        },
      });
      (executeQuery as jest.Mock).mockRejectedValueOnce(new Error('boom'));
      const failed = await client.callTool({
        name: 'execute-query',
        arguments: { query: 'T | take 1', limit: 100 },
      });
      expect(failed.isError).toBe(true);

      const ok = await client.callTool({
        name: 'execute-query',
        arguments: { query: 'T | take 1', limit: 100 },
      });
      expect(ok.isError).toBeFalsy();

      const [, second] = toolSpans();
      expect(second.attributes['kustomcp.query.retry_class']).toBe(
        'after_error',
      );
      expect(second.attributes['kustomcp.query.limit_escalation']).toBe('same');
    } finally {
      await close();
    }
  });

  test.each([
    [
      'blocked by read-only mode',
      async (client: Client) => {
        await client.callTool({
          name: 'initialize-connection',
          arguments: {
            cluster_url: 'https://x.kusto.windows.net',
            database: 'd',
          },
        });
        return { query: '.drop table T', limit: 100 };
      },
    ],
    [
      'connection not initialized',
      async () => ({ query: 'T | take 1', limit: 100 }),
    ],
  ])(
    'a pre-execution failure (%s) still records its limit',
    async (_label, firstCall) => {
      // Writes are on by default; turn them off so `.drop` is rejected.
      const { client, close } = await connect({ allowWriteOperations: false });
      try {
        const failed = await client.callTool({
          name: 'execute-query',
          arguments: await firstCall(client),
        });
        expect(failed.isError).toBe(true);

        await client.callTool({
          name: 'initialize-connection',
          arguments: {
            cluster_url: 'https://x.kusto.windows.net',
            database: 'd',
          },
        });
        const ok = await client.callTool({
          name: 'execute-query',
          arguments: { query: 'T | take 1', limit: 100 },
        });
        expect(ok.isError).toBeFalsy();

        // The failed call's own span carries the input-derived dimensions.
        const [failedSpan, second] = toolSpans();
        expect(failedSpan.status.code).toBe(2); // ERROR
        expect(failedSpan.attributes['kustomcp.declared.purpose']).toBe(
          'unspecified',
        );
        expect(failedSpan.attributes['kustomcp.query.requested_limit']).toBe(
          100,
        );
        expect(failedSpan.attributes['kustomcp.query.stmt_kind']).toBeDefined();
        expect(failedSpan.attributes['kustomcp.session.query_ordinal']).toBe(
          '1',
        );
        expect(second.attributes['kustomcp.query.retry_class']).toBe(
          'after_error',
        );
        expect(second.attributes['kustomcp.query.limit_escalation']).toBe(
          'same',
        );
      } finally {
        await close();
      }
    },
  );

  // LLMs are free to ignore the optional `purpose` hint. Everything must still
  // work and be reported as `unspecified`.
  describe('purpose omitted by the caller', () => {
    const NOT_PROVIDED: Array<[string, Record<string, unknown>]> = [
      ['key absent', { query: 'T | take 1' }],
      ['key absent, limit given', { query: 'T | take 1', limit: 5 }],
      ['explicit undefined-like null', { query: 'T | take 1', purpose: null }],
      ['empty string', { query: 'T | take 1', purpose: '' }],
      ['whitespace only', { query: 'T | take 1', purpose: '   ' }],
      ['non-string number', { query: 'T | take 1', purpose: 7 }],
      ['non-string object', { query: 'T | take 1', purpose: { a: 1 } }],
    ];

    test.each(NOT_PROVIDED)(
      '%s: call succeeds, returns data, purpose is unspecified',
      async (_label, args) => {
        const { client, close } = await connect();
        try {
          await client.callTool({
            name: 'initialize-connection',
            arguments: {
              cluster_url: 'https://x.kusto.windows.net',
              database: 'd',
            },
          });
          const res = await client.callTool({
            name: 'execute-query',
            arguments: args,
          });
          expect(res.isError).toBeFalsy();
          const text = (res.content as Array<{ text: string }>)[0].text;
          expect(text).toContain('"a"'); // result rows still come back

          const [span] = toolSpans();
          const attrs = span.attributes;
          expect(attrs['kustomcp.declared.purpose']).toBe('unspecified');
          expect(attrs['kustomcp.declared.purpose_unlisted']).toBeUndefined();
          // Everything else is still reported.
          expect(attrs['kustomcp.query.stmt_kind']).toBe('query');
          expect(attrs['kustomcp.query.operators']).toEqual(['take']);
          expect(attrs['kustomcp.session.query_ordinal']).toBe('1');
          expect(attrs['kustomcp.query.retry_class']).toBe('first');
          expect(attrs['kustomcp.result.row_count']).toBe(2);
        } finally {
          await close();
        }
      },
    );

    test('a run of calls with no purpose never errors and stays unspecified', async () => {
      const { client, close } = await connect();
      try {
        await client.callTool({
          name: 'initialize-connection',
          arguments: {
            cluster_url: 'https://x.kusto.windows.net',
            database: 'd',
          },
        });
        for (let i = 0; i < 4; i++) {
          const res = await client.callTool({
            name: 'execute-query',
            arguments: { query: `T | take ${i + 1}` },
          });
          expect(res.isError).toBeFalsy();
        }
        const spans = toolSpans();
        expect(spans).toHaveLength(4);
        for (const span of spans) {
          expect(span.attributes['kustomcp.declared.purpose']).toBe(
            'unspecified',
          );
        }
        expect(spans[3].attributes['kustomcp.session.query_ordinal']).toBe(
          '4-5',
        );
      } finally {
        await close();
      }
    });

    test('a failing query without purpose is still recorded and does not throw', async () => {
      const { client, close } = await connect();
      try {
        // No connection initialized -> the tool errors before running.
        const res = await client.callTool({
          name: 'execute-query',
          arguments: { query: 'T | take 1' },
        });
        expect(res.isError).toBe(true);
        const [span] = toolSpans();
        expect(span.attributes['kustomcp.declared.purpose']).toBe(
          'unspecified',
        );
        expect(span.attributes['kustomcp.query.requested_limit']).toBe(20);
      } finally {
        await close();
      }
    });
  });
});
