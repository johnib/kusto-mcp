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

async function connect() {
  const server = createKustoServer({});
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
        arguments: { cluster_url: 'https://x.kusto.windows.net', database: 'd' },
      });
      // The mocked connection can't list tables, so this call errors; it still
      // counts as a schema lookup for the session signals.
      await client.callTool({ name: 'show-tables', arguments: {} });

      const r1 = await client.callTool({
        name: 'execute-query',
        arguments: { purpose: 'bulk_extract', query: SECRET_QUERY, limit: 10 },
      });
      expect(r1.isError).toBeFalsy();

      // Off-list purpose must not fail the call.
      const r2 = await client.callTool({
        name: 'execute-query',
        arguments: {
          purpose: 'SELECT secrets FROM customers',
          query: SECRET_QUERY,
          limit: 50,
        },
      });
      expect(r2.isError).toBeFalsy();

      const [first, second] = toolSpans();
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
      expect(a2['kustomcp.declared.purpose']).toBe('unspecified');
      expect(a2['kustomcp.session.prev_tool']).toBe('execute-query');
      expect(a2['kustomcp.session.query_ordinal']).toBe('2');
      expect(a2['kustomcp.query.retry_class']).toBe('after_success');
      expect(a2['kustomcp.query.limit_escalation']).toBe('raised');

      for (const span of exporter.getFinishedSpans()) {
        const dump = JSON.stringify(span.attributes);
        expect(dump).not.toContain('AcmeSecretTable');
        expect(dump).not.toContain('p@ssw0rd');
        expect(dump).not.toContain('secrets FROM customers');
      }
    } finally {
      await close();
    }
  });
});
