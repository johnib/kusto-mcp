/**
 * Markdown Formatter Unit Tests
 * Tests for formatting query results, including dynamic column handling
 */

import { execFileSync } from 'child_process';
import path from 'path';
import { markdownTable } from 'markdown-table';
import {
  formatAsMarkdownTable,
  formatQueryResult,
  QueryResult,
} from '../../../src/common/markdown-formatter.js';

/**
 * Split a GFM table row into cells the way cmark-gfm does: a backslash
 * escapes the next character (so `\\|` is an escaped backslash followed by a
 * delimiter), and only an unescaped `|` separates cells.
 */
function splitGfmRow(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) {
      current += ch + line[i + 1];
      i++;
    } else if (ch === '|') {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  // Drop the empty strings outside the leading and trailing pipes
  return cells.slice(1, -1).map(c => c.trim());
}

/** GFM cell unescaping: `\|` -> `|` first, then inline `\\` -> `\`. */
function unescapeGfmCell(cell: string): string {
  return cell.replace(/\\\|/g, '|').replace(/\\\\/g, '\\');
}

/**
 * tests/unit/setup.ts replaces markdown-table with a naive joiner, and the real
 * package is ESM-only so jest's CJS runtime cannot requireActual it. Render the
 * rows the formatter handed to the mock with the real library in a child Node
 * process instead.
 */
function renderWithRealMarkdownTable(rows: string[][]): string {
  const script = [
    "import { markdownTable } from 'markdown-table';",
    "import { readFileSync } from 'fs';",
    'const rows = JSON.parse(readFileSync(0, "utf8"));',
    'process.stdout.write(markdownTable(rows, { padding: true, alignDelimiters: true }));',
  ].join('\n');
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.resolve(__dirname, '../../..'),
    input: JSON.stringify(rows),
    encoding: 'utf8',
  });
}

function lastTableDataPassedToMarkdownTable(): string[][] {
  const calls = (markdownTable as unknown as jest.Mock).mock.calls;
  return calls[calls.length - 1][0] as string[][];
}

// Since formatCellValue is not exported, we'll test it indirectly through formatAsMarkdownTable

describe('Markdown Formatter Unit Tests', () => {
  const createTestQueryResult = (
    data: Array<Record<string, unknown>>,
  ): QueryResult => ({
    name: 'TestResult',
    data,
    metadata: {
      rowCount: data.length,
      isPartial: false,
      requestedLimit: 20,
      hasMoreResults: false,
    },
  });

  describe('formatCellValue function (dynamic column support)', () => {
    test('should handle simple objects correctly', () => {
      const jsonObject = { name: 'John', age: 30, active: true };
      const testData = createTestQueryResult([{ dynamicColumn: jsonObject }]);

      const result = formatAsMarkdownTable(testData);

      // Should contain the JSON string representation
      expect(result).toContain('{"name":"John","age":30,"active":true}');
      expect(result).not.toContain('[object Object]');
    });

    test('should handle arrays correctly', () => {
      const jsonArray = [1, 2, 3, 'test'];
      const testData = createTestQueryResult([{ arrayColumn: jsonArray }]);

      const result = formatAsMarkdownTable(testData);

      // Should show proper JSON array representation
      expect(result).toContain('[1,2,3,"test"]');
      expect(result).not.toContain('[object Object]');
    });

    test('should handle nested objects correctly', () => {
      const nestedObject = {
        user: { name: 'John', details: { age: 30 } },
        settings: { theme: 'dark', notifications: true },
      };
      const testData = createTestQueryResult([{ nestedData: nestedObject }]);

      const result = formatAsMarkdownTable(testData);

      // Should contain proper JSON representation of nested object
      expect(result).toContain(
        '{"user":{"name":"John","details":{"age":30}},"settings":{"theme":"dark","notifications":true}}',
      );
      expect(result).not.toContain('[object Object]');
    });

    test('should handle mixed data types in same row', () => {
      const mixedData = {
        stringCol: 'simple string',
        numberCol: 42,
        booleanCol: true,
        objectCol: { key: 'value', count: 5 },
        arrayCol: ['item1', 'item2'],
        nullCol: null,
        undefinedCol: undefined,
      };

      const testData = createTestQueryResult([mixedData]);
      const result = formatAsMarkdownTable(testData);

      // String, number, boolean should work fine
      expect(result).toContain('simple string');
      expect(result).toContain('42');
      expect(result).toContain('true');
      expect(result).toContain(''); // null/undefined should be empty

      // Objects and arrays should be JSON, not [object Object]
      expect(result).toContain('{"key":"value","count":5}');
      expect(result).toContain('["item1","item2"]');
      expect(result).not.toContain('[object Object]');
    });

    test('should handle Date objects correctly', () => {
      const testDate = new Date('2023-12-25T10:30:00Z');
      const testData = createTestQueryResult([{ dateColumn: testDate }]);

      const result = formatAsMarkdownTable(testData);

      // Date should be converted to ISO string (existing functionality)
      expect(result).toContain('2023-12-25T10:30:00.000Z');
    });
  });

  describe('Real-world Kusto dynamic column scenarios', () => {
    test('should handle Kusto dynamic column with complex JSON', () => {
      // Simulate what Kusto returns for dynamic columns
      const kustoRecord = {
        timestamp: new Date('2023-12-25T10:30:00Z'),
        level: 'INFO',
        message: 'User action completed',
        properties: {
          userId: 'user123',
          action: 'login',
          metadata: {
            ip: '192.168.1.1',
            userAgent: 'Mozilla/5.0...',
            sessionId: 'sess_abc123',
          },
          duration: 1250,
        },
        tags: ['authentication', 'user-activity'],
      };

      const testData: QueryResult = {
        name: 'KustoLogs',
        data: [kustoRecord],
        metadata: {
          rowCount: 1,
          isPartial: false,
          requestedLimit: 20,
          hasMoreResults: false,
        },
      };

      const result = formatAsMarkdownTable(testData);

      // Should properly serialize the complex properties object
      expect(result).toContain('"userId":"user123"');
      expect(result).toContain('"action":"login"');
      expect(result).toContain('"ip":"192.168.1.1"');
      expect(result).toContain('["authentication","user-activity"]');
      expect(result).not.toContain('[object Object]');
    });
  });

  describe('Edge cases and error handling', () => {
    test('should handle circular references gracefully', () => {
      // Create an object with circular reference
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const circularObj: any = { name: 'test' };
      circularObj.self = circularObj;

      const testData = createTestQueryResult([{ circularColumn: circularObj }]);
      const result = formatAsMarkdownTable(testData);

      // Should fallback to [object Object] for circular references
      expect(result).toContain('[object Object]');
      expect(result).not.toContain('JSON.stringify');
    });

    test('should handle primitive values correctly (existing functionality)', () => {
      const primitiveData = {
        stringVal: 'test string',
        numberVal: 123.45,
        booleanVal: false,
        nullVal: null,
        undefinedVal: undefined,
      };

      const testData: QueryResult = {
        name: 'PrimitiveTest',
        data: [primitiveData],
        metadata: {
          rowCount: 1,
          isPartial: false,
          requestedLimit: 20,
          hasMoreResults: false,
        },
      };

      const result = formatAsMarkdownTable(testData);

      expect(result).toContain('test string');
      expect(result).toContain('123.45');
      expect(result).toContain('false');
      // null and undefined should become empty strings
      expect(result).toMatch(/\|\s*\|/); // Empty cells
    });

    test('should handle empty data gracefully', () => {
      const testData: QueryResult = {
        name: 'EmptyTest',
        data: [],
        metadata: {
          rowCount: 0,
          isPartial: false,
          requestedLimit: 20,
          hasMoreResults: false,
        },
      };

      const result = formatAsMarkdownTable(testData);
      expect(result).toContain('*No results returned*');
    });
  });

  describe('Pipe escaping in markdown cells', () => {
    const tableLines = (markdown: string): string[] =>
      markdown.split('\n').filter(line => line.startsWith('|'));

    test('string containing | is escaped and keeps the column count', () => {
      const testData = createTestQueryResult([{ Text: 'a|b', Id: 1 }]);

      const result = formatAsMarkdownTable(testData);

      expect(result).toContain('a\\|b');
      const [header, , row] = tableLines(result);
      expect(splitGfmRow(header)).toHaveLength(2);
      expect(splitGfmRow(row)).toEqual(['a\\|b', '1']);
    });

    test('dynamic object whose JSON contains | is escaped', () => {
      const testData = createTestQueryResult([
        { Payload: { s: 'x|y\nz' }, Id: 1 },
      ]);

      const result = formatAsMarkdownTable(testData);

      expect(result).toContain('{"s":"x\\|y\\nz"}');
      const [, , row] = tableLines(result);
      expect(splitGfmRow(row)).toEqual(['{"s":"x\\|y\\nz"}', '1']);
    });

    test('array JSON containing | is escaped', () => {
      const testData = createTestQueryResult([{ Tags: ['a|b', 'c'] }]);

      const result = formatAsMarkdownTable(testData);

      expect(result).toContain('["a\\|b","c"]');
    });

    test('String() fallback for non-serializable values is escaped', () => {
      const weird = {
        toJSON() {
          throw new Error('not serializable');
        },
        toString() {
          return 'p|q';
        },
      };
      const testData = createTestQueryResult([{ Col: weird, Id: 1 }]);

      const result = formatAsMarkdownTable(testData);

      const [, , row] = tableLines(result);
      expect(splitGfmRow(row)).toEqual(['p\\|q', '1']);
    });

    test('column name containing | is escaped', () => {
      const testData = createTestQueryResult([{ 'a|b': 1, c: 2 }]);

      const result = formatAsMarkdownTable(testData);

      const [header, , row] = tableLines(result);
      expect(splitGfmRow(header)).toEqual(['a\\|b', 'c']);
      expect(splitGfmRow(row)).toHaveLength(2);
    });

    test('pre-existing backslashes before | round-trip unambiguously', () => {
      const raw = ['x\\|y', 'x\\\\|y', 'C:\\path\\to'];
      const testData = createTestQueryResult([
        { A: raw[0], B: raw[1], C: raw[2] },
      ]);

      const result = formatAsMarkdownTable(testData);

      const [, , row] = tableLines(result);
      const cells = splitGfmRow(row);
      expect(cells).toHaveLength(3);
      expect(cells.map(unescapeGfmCell)).toEqual(raw);
      // Backslashes not adjacent to a pipe are left untouched
      expect(cells[2]).toBe('C:\\path\\to');
    });

    test('real markdown-table output keeps the header column count', () => {
      formatAsMarkdownTable(
        createTestQueryResult([
          { Payload: { s: 'x|y\nz' }, 'Na|me': 'a\\|b', Id: 1 },
        ]),
      );

      const rendered = renderWithRealMarkdownTable(
        lastTableDataPassedToMarkdownTable(),
      );

      const lines = tableLines(rendered);
      expect(lines).toHaveLength(3);
      for (const line of lines) {
        expect(splitGfmRow(line)).toHaveLength(3);
      }
      expect(splitGfmRow(lines[0]).map(unescapeGfmCell)).toEqual([
        'Payload',
        'Na|me',
        'Id',
      ]);
      expect(splitGfmRow(lines[2]).map(unescapeGfmCell)).toEqual([
        '{"s":"x|y\\nz"}',
        'a\\|b',
        '1',
      ]);
    });

    test('JSON format output keeps raw | (no escaping)', () => {
      const testData = createTestQueryResult([
        { Text: 'a|b', Payload: { s: 'x|y' } },
      ]);

      const result = formatQueryResult(testData, 'json');

      expect(result).not.toContain('\\|');
      const parsed = JSON.parse(result);
      expect(parsed.data[0].Text).toBe('a|b');
      expect(parsed.data[0].Payload.s).toBe('x|y');
    });
  });

  describe('JSON format output', () => {
    test('should format as JSON when requested', () => {
      const testData: QueryResult = {
        name: 'JSONTest',
        data: [{ obj: { key: 'value' } }],
        metadata: {
          rowCount: 1,
          isPartial: false,
          requestedLimit: 20,
          hasMoreResults: false,
        },
      };

      const result = formatQueryResult(testData, 'json');

      // Should be valid JSON
      expect(() => JSON.parse(result)).not.toThrow();
      const parsed = JSON.parse(result);
      expect(parsed.data[0].obj.key).toBe('value');
    });
  });
});
