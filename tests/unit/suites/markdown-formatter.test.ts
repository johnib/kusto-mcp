/**
 * Markdown Formatter Unit Tests
 * Tests for formatting query results, including dynamic column handling
 */

import {
  formatAsMarkdownTable,
  formatQueryResult,
  QueryResult,
} from '../../../src/common/markdown-formatter.js';

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
