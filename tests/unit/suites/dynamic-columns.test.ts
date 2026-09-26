/**
 * Kusto `dynamic` column values, end to end: raw `_rows` as azure-kusto-data
 * returns them → transformQueryResult → formatter / response limiter → the
 * execute-query tool's text output.
 *
 * The tool is driven through a real MCP Client over an in-memory transport.
 * KustoConnection is stubbed at the prototype so no auth, network, or
 * first-connection disk write happens. Note that `markdown-table` is mocked
 * globally in tests/unit/setup.ts; like the real library (3.x), the mock does
 * not escape `|` inside cells.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { KustoConnection } from '../../../src/operations/kusto/connection.js';
import { transformQueryResult } from '../../../src/operations/kusto/queries.js';
import { createKustoServer } from '../../../src/server.js';
import type { KustoQueryResult } from '../../../src/types/kusto-interfaces.js';
import {
  AuthenticationMethod,
  KustoConfig,
  ResponseFormat,
} from '../../../src/types/config.js';
import {
  dynamicColumnNames,
  dynamicRowValues,
  dynamicValuesResponse,
  HUGE_PAYLOAD_LENGTH,
  hugeCellAfterSmallRowsResponse,
  hugeCellFirstResponse,
  pipeAndNewlineResponse,
} from '../fixtures/dynamic-columns-responses.js';

// version.ts reads package.json via `import.meta.url`, which the CJS jest
// runtime cannot load.
jest.mock('../../../src/common/version.js', () => ({ VERSION: '0.0.0-test' }));

const GLOBAL_CHAR_LIMIT = 12000;

type CallToolResult = Awaited<ReturnType<Client['callTool']>>;

function textOf(result: CallToolResult): string {
  const content: unknown = result.content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error('tool result has no content');
  }
  const first: unknown = content[0];
  if (
    typeof first === 'object' &&
    first !== null &&
    'text' in first &&
    typeof first.text === 'string'
  ) {
    return first.text;
  }
  throw new Error('first content item is not text');
}

interface JsonToolResponse {
  data: Array<Record<string, unknown>>;
  metadata: {
    rowCount: number;
    isPartial: boolean;
    hasMoreResults: boolean;
    reducedForResponseSize?: boolean;
    originalRowsAvailable?: number;
    globalCharLimit?: number;
    responseCharCount?: number;
  };
  message?: string;
}

function parseJsonResponse(text: string): JsonToolResponse {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || !('data' in parsed)) {
    throw new Error('response is not a query result object');
  }
  return parsed as JsonToolResponse;
}

/** Split a markdown table row into cells on unescaped `|`. */
function cellsOf(row: string): string[] {
  const trimmed = row.trim();
  expect(trimmed.startsWith('|')).toBe(true);
  expect(trimmed.endsWith('|')).toBe(true);
  return trimmed
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .map(cell => cell.trim());
}

/** Table lines only (the metadata summary follows after a blank line). */
function tableLinesOf(markdown: string): string[] {
  const [table] = markdown.split('\n\n');
  return table.split('\n').filter(line => line.length > 0);
}

async function callExecuteQuery(
  config: Partial<KustoConfig>,
  raw: KustoQueryResult,
): Promise<string> {
  jest.spyOn(KustoConnection.prototype, 'executeQuery').mockResolvedValue(raw);

  const server = createKustoServer({
    authMethod: AuthenticationMethod.AzureCli,
    ...config,
  });
  const client = new Client({ name: 'dynamic-columns-test', version: '0.0.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  try {
    await client.callTool({
      name: 'initialize-connection',
      arguments: {
        cluster_url: 'https://contoso.kusto.windows.net',
        database: 'ContosoSales',
      },
    });
    const result = await client.callTool({
      name: 'execute-query',
      arguments: {
        query: 'Events | project Obj, Arr, Nul, EmptyObj, EmptyArr',
      },
    });
    expect(result.isError).toBeFalsy();
    return textOf(result);
  } finally {
    await client.close();
    await server.close();
  }
}

describe('Kusto dynamic column values', () => {
  beforeEach(() => {
    jest.spyOn(KustoConnection.prototype, 'initialize').mockResolvedValue({
      success: true,
      cluster: 'https://contoso.kusto.windows.net',
      database: 'ContosoSales',
    });
    jest
      .spyOn(KustoConnection.prototype, 'isInitialized')
      .mockReturnValue(true);
    jest
      .spyOn(KustoConnection.prototype, 'getDatabase')
      .mockReturnValue('ContosoSales');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('transformQueryResult', () => {
    test('passes dynamic values through untouched, not stringified', () => {
      const raw = dynamicValuesResponse();
      const inputRow = raw.primaryResults[0]._rows![0];

      const { data } = transformQueryResult(raw);

      expect(data).toHaveLength(1);
      const row = data[0];
      expect(Object.keys(row)).toStrictEqual([...dynamicColumnNames]);

      const expected = dynamicRowValues();
      dynamicColumnNames.forEach((name, index) => {
        expect(row[name]).toStrictEqual(expected[index]);
        // Same reference as the raw cell: no copy, no JSON round-trip.
        expect(row[name]).toBe(inputRow[index]);
      });

      expect(typeof row.Obj).toBe('object');
      expect(Array.isArray(row.Obj)).toBe(false);
      expect(Array.isArray(row.Arr)).toBe(true);
      expect(row.Nul).toBeNull();
      expect(Array.isArray(row.EmptyObj)).toBe(false);
      expect(typeof row.EmptyObj).toBe('object');
      expect(Array.isArray(row.EmptyArr)).toBe(true);
      for (const name of dynamicColumnNames) {
        expect(typeof row[name]).not.toBe('string');
      }
    });
  });

  describe('execute-query markdown output', () => {
    test('renders dynamic cells as compact single-line JSON', async () => {
      const text = await callExecuteQuery(
        { responseFormat: ResponseFormat.Markdown },
        dynamicValuesResponse(),
      );

      const lines = tableLinesOf(text);
      // header, delimiter, one data row
      expect(lines).toHaveLength(3);
      expect(cellsOf(lines[0])).toStrictEqual([...dynamicColumnNames]);
      expect(cellsOf(lines[2])).toStrictEqual([
        '{"a":1,"b":{"c":[1,2]}}',
        '[1,"x",null]',
        '',
        '{}',
        '[]',
      ]);
    });

    test('a newline inside a dynamic value stays on one table line', async () => {
      const text = await callExecuteQuery(
        { responseFormat: ResponseFormat.Markdown },
        pipeAndNewlineResponse,
      );

      const lines = tableLinesOf(text);
      expect(lines).toHaveLength(3);
      // JSON.stringify escapes the newline, so the row is not split.
      expect(lines[2]).toContain('\\n');
    });

    // BUG (src/common/markdown-formatter.ts formatCellValue): `|` inside a
    // dynamic value is not escaped, so the data row splits into more cells
    // than the header has. markdown-table 3.x does not escape it either.
    test.failing(
      'a pipe inside a dynamic value does not break the row structure',
      async () => {
        const text = await callExecuteQuery(
          { responseFormat: ResponseFormat.Markdown },
          pipeAndNewlineResponse,
        );

        const lines = tableLinesOf(text);
        const header = cellsOf(lines[0]);
        const dataRow = cellsOf(lines[2]);
        expect(header).toStrictEqual(['Payload', 'Id']);
        expect(dataRow).toHaveLength(header.length);
        expect(dataRow[1]).toBe('1');
      },
    );
  });

  describe('execute-query JSON output', () => {
    test('keeps dynamic values as nested JSON, not encoded strings', async () => {
      const text = await callExecuteQuery(
        { responseFormat: ResponseFormat.Json },
        dynamicValuesResponse(),
      );

      const response = parseJsonResponse(text);
      expect(response.data).toHaveLength(1);
      const row = response.data[0];

      expect(row.Obj).toStrictEqual({ a: 1, b: { c: [1, 2] } });
      expect(row.Arr).toStrictEqual([1, 'x', null]);
      expect(row.Nul).toBeNull();
      expect(row.EmptyObj).toStrictEqual({});
      expect(row.EmptyArr).toStrictEqual([]);
      for (const name of dynamicColumnNames) {
        expect(typeof row[name]).not.toBe('string');
      }
    });
  });

  describe('response limiter with an oversized dynamic cell', () => {
    test('JSON: drops the huge row and everything after it, stays under the cap', async () => {
      const text = await callExecuteQuery(
        { responseFormat: ResponseFormat.Json },
        hugeCellAfterSmallRowsResponse(),
      );

      expect(text.length).toBeLessThanOrEqual(GLOBAL_CHAR_LIMIT);
      const response = parseJsonResponse(text);

      expect(response.data.map(row => row.Id)).toStrictEqual([1, 2, 3, 4, 5]);
      expect(response.data[0].Props).toStrictEqual({ tag: 't1', n: [1] });
      expect(response.metadata).toMatchObject({
        rowCount: 5,
        isPartial: true,
        hasMoreResults: true,
        reducedForResponseSize: true,
        originalRowsAvailable: 8,
        globalCharLimit: GLOBAL_CHAR_LIMIT,
      });
      expect(response.message).toMatch(/reduced to fit response size limit/);
    });

    test('markdown: huge first row is truncated per cell and fits the cap', async () => {
      const text = await callExecuteQuery(
        { responseFormat: ResponseFormat.Markdown },
        hugeCellFirstResponse(),
      );

      expect(text.length).toBeLessThanOrEqual(GLOBAL_CHAR_LIMIT);
      const lines = tableLinesOf(text);
      expect(lines.length).toBeGreaterThanOrEqual(3);
      // default markdownMaxCellLength (1000) truncates with an ellipsis
      const hugeCell = cellsOf(lines[2])[1];
      expect(hugeCell.length).toBeLessThanOrEqual(1000);
      expect(hugeCell.endsWith('...')).toBe(true);
    });

    test('JSON: huge first row still yields parseable output with minRows = 1', async () => {
      const text = await callExecuteQuery(
        { responseFormat: ResponseFormat.Json },
        hugeCellFirstResponse(),
      );

      const response = parseJsonResponse(text);
      expect(response.data).toHaveLength(1);
      expect(response.metadata).toMatchObject({
        rowCount: 1,
        isPartial: true,
        reducedForResponseSize: true,
        originalRowsAvailable: 4,
      });
      // Documents current behavior: the one-row minimum wins over the cap.
      expect(text.length).toBeGreaterThan(HUGE_PAYLOAD_LENGTH);
    });

    // BUG (src/common/response-limiter.ts findOptimalRowCount): when even
    // `minRows` rows exceed maxLength, the minRows response is returned
    // anyway, so a single ~20k-char JSON cell ships a ~20k-char response
    // past the 12000-char cap.
    test.failing(
      'JSON: huge first row output stays within the 12000-char cap',
      async () => {
        const text = await callExecuteQuery(
          { responseFormat: ResponseFormat.Json },
          hugeCellFirstResponse(),
        );

        expect(text.length).toBeLessThanOrEqual(GLOBAL_CHAR_LIMIT);
      },
    );
  });
});
