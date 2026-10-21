/**
 * Response Limiter Unit Tests
 */

import { QueryResult } from '../../../src/common/markdown-formatter.js';
import {
  limitResponseSize,
  ResponseLimitOptions,
} from '../../../src/common/response-limiter.js';

describe('Response Limiter Unit Tests', () => {
  const createTestQueryResult = (rowCount: number): QueryResult => {
    const data = Array.from({ length: rowCount }, (_, i) => ({
      id: i + 1,
      name: `Item ${i + 1}`,
      description: `This is a description for item ${
        i + 1
      } with some additional text to make it longer`,
      value: Math.random() * 1000,
    }));

    return {
      name: 'TestResult',
      data,
      metadata: {
        rowCount: data.length,
        isPartial: false,
        requestedLimit: 20,
        hasMoreResults: false,
      },
      message: 'Test query result',
    };
  };

  describe('Basic functionality', () => {
    test('should return full response when it fits within limit', () => {
      const testData = createTestQueryResult(2);
      const options: ResponseLimitOptions = {
        maxLength: 10000,
        minRows: 1,
        format: 'json',
      };

      const result = limitResponseSize(testData, options);

      expect(result.wasReduced).toBe(false);
      expect(result.optimalRowCount).toBe(2);
      expect(result.originalRowCount).toBe(2);
      expect(result.finalCharCount).toBeLessThanOrEqual(10000);
    });

    test('should reduce rows when response exceeds limit', () => {
      const testData = createTestQueryResult(10);
      const options: ResponseLimitOptions = {
        maxLength: 800, // Small limit to force reduction
        minRows: 1,
        format: 'json',
      };

      const result = limitResponseSize(testData, options);

      expect(result.wasReduced).toBe(true);
      expect(result.optimalRowCount).toBeLessThan(10);
      expect(result.optimalRowCount).toBeGreaterThanOrEqual(1);
      expect(result.originalRowCount).toBe(10);
      expect(result.finalCharCount).toBeLessThanOrEqual(800);
    });

    test('should respect minimum rows constraint', () => {
      const testData = createTestQueryResult(5);
      const options: ResponseLimitOptions = {
        maxLength: 100, // Very small limit
        minRows: 3,
        format: 'json',
      };

      const result = limitResponseSize(testData, options);

      expect(result.optimalRowCount).toBeGreaterThanOrEqual(3);
    });

    test('should handle empty data', () => {
      const testData = createTestQueryResult(0);
      const options: ResponseLimitOptions = {
        maxLength: 1000,
        minRows: 1,
        format: 'json',
      };

      const result = limitResponseSize(testData, options);

      expect(result.wasReduced).toBe(false);
      expect(result.optimalRowCount).toBe(0);
      expect(result.originalRowCount).toBe(0);
    });
  });

  describe('Format handling', () => {
    test('should work with JSON format', () => {
      const testData = createTestQueryResult(3);
      const options: ResponseLimitOptions = {
        maxLength: 2000,
        minRows: 1,
        format: 'json',
      };

      const result = limitResponseSize(testData, options);

      expect(() => JSON.parse(result.content)).not.toThrow();
      const parsed = JSON.parse(result.content);
      expect(parsed.data).toHaveLength(result.optimalRowCount);
    });

    test('should work with Markdown format', () => {
      const testData = createTestQueryResult(3);
      const options: ResponseLimitOptions = {
        maxLength: 2000,
        minRows: 1,
        format: 'markdown',
        formatOptions: {
          showMetadata: true,
        },
      };

      const result = limitResponseSize(testData, options);

      expect(result.content).toContain('|');
      expect(result.content).toContain('Query Results Summary');
    });
  });

  describe('Metadata handling', () => {
    test('should include global limiting metadata when reduction occurs', () => {
      const testData = createTestQueryResult(10);
      const options: ResponseLimitOptions = {
        maxLength: 800,
        minRows: 1,
        format: 'json',
      };

      const result = limitResponseSize(testData, options);

      if (result.wasReduced) {
        const parsed = JSON.parse(result.content);
        expect(parsed.metadata.reducedForResponseSize).toBe(true);
        expect(parsed.metadata.originalRowsAvailable).toBe(10);
        expect(parsed.metadata.globalCharLimit).toBe(800);
        expect(parsed.message).toContain(
          'Row count reduced to fit response size limit',
        );
      }
    });

    test('should preserve original metadata when no reduction needed', () => {
      const testData = createTestQueryResult(2);
      const options: ResponseLimitOptions = {
        maxLength: 10000,
        minRows: 1,
        format: 'json',
      };

      const result = limitResponseSize(testData, options);

      const parsed = JSON.parse(result.content);
      expect(parsed.metadata.reducedForResponseSize).toBeFalsy();
      expect(parsed.message).toBe('Test query result');
    });
  });

  describe('Error handling', () => {
    test('should validate minimum character limit', () => {
      const testData = createTestQueryResult(1);
      const options: ResponseLimitOptions = {
        maxLength: 50, // Too small
        minRows: 1,
        format: 'json',
      };

      expect(() => limitResponseSize(testData, options)).toThrow(
        'Global response limit must be at least 100 characters',
      );
    });

    test('should validate minimum rows parameter', () => {
      const testData = createTestQueryResult(1);
      const options: ResponseLimitOptions = {
        maxLength: 1000,
        minRows: -1, // Invalid
        format: 'json',
      };

      expect(() => limitResponseSize(testData, options)).toThrow(
        'Minimum rows must be non-negative',
      );
    });
  });

  describe('Binary search optimization', () => {
    test('should efficiently find optimal row count for large datasets', () => {
      const testData = createTestQueryResult(100);
      const options: ResponseLimitOptions = {
        maxLength: 3000,
        minRows: 1,
        format: 'json',
      };

      const startTime = Date.now();
      const result = limitResponseSize(testData, options);
      const endTime = Date.now();

      expect(result.wasReduced).toBe(true);
      expect(result.optimalRowCount).toBeLessThan(100);
      expect(result.finalCharCount).toBeLessThanOrEqual(3000);
      expect(endTime - startTime).toBeLessThan(100); // Should be fast
    });
  });

  describe('A single row larger than the cap', () => {
    const giantRow = (): QueryResult => ({
      name: 'PrimaryResult',
      data: [{ id: 1, payload: 'x'.repeat(50_000), tag: 'short' }],
      metadata: {
        rowCount: 1,
        isPartial: false,
        requestedLimit: 20,
        hasMoreResults: false,
      },
    });

    test.each(['json', 'markdown'] as const)(
      '%s: truncates the long cell so the response fits, with a marker',
      format => {
        const result = limitResponseSize(giantRow(), {
          maxLength: 12000,
          minRows: 1,
          format,
          formatOptions: { showMetadata: true },
        });

        expect(result.content.length).toBeLessThanOrEqual(12000);
        expect(result.finalCharCount).toBe(result.content.length);
        expect(result.wasReduced).toBe(true);
        expect(result.optimalRowCount).toBe(1);
        expect(result.content).toMatch(/…\[truncated \d+ chars\]/);
        // Short cells are left alone.
        expect(result.content).toContain('short');
        expect(result.content).toContain('truncated');
        if (format === 'json') {
          const parsed = JSON.parse(result.content);
          expect(parsed.metadata.reducedForResponseSize).toBe(true);
          const kept = parsed.data[0].payload as string;
          const dropped = Number(/truncated (\d+) chars/.exec(kept)![1]);
          expect(kept.indexOf('…')).toBe(50_000 - dropped);
        } else {
          expect(result.content).toContain('Reduced for response size: Yes');
        }
      },
    );

    test('truncates non-string (dynamic) cells too', () => {
      const data = [{ obj: { blob: 'y'.repeat(30_000) } }];
      const result = limitResponseSize(
        {
          data,
          metadata: {
            rowCount: 1,
            isPartial: false,
            requestedLimit: 20,
            hasMoreResults: false,
          },
        },
        { maxLength: 5000, minRows: 1, format: 'json' },
      );
      expect(result.content.length).toBeLessThanOrEqual(5000);
      expect(result.content).toMatch(/truncated \d+ chars/);
    });

    test.each(['json', 'markdown'] as const)(
      '%s: a wide row of short cells keeps its values, no markers',
      format => {
        const row: Record<string, unknown> = {};
        for (let i = 0; i < 400; i++) {
          row[`SomeFairlyLongColumnName_${i}`] = `value-${i}-abcdef`;
        }
        const wide = (): QueryResult => ({
          data: [row],
          metadata: {
            rowCount: 1,
            isPartial: false,
            requestedLimit: 20,
            hasMoreResults: false,
          },
        });
        const untruncated = limitResponseSize(wide(), {
          maxLength: 1_000_000,
          minRows: 1,
          format,
        });
        const result = limitResponseSize(wide(), {
          maxLength: 12000,
          minRows: 1,
          format,
        });
        expect(result.content.length).toBeLessThanOrEqual(
          untruncated.content.length,
        );
        expect(result.content).not.toMatch(/truncated \d+ chars/);
        expect(result.content).toContain('value-399-abcdef');
      },
    );

    test('a wide row plus one huge cell cuts only the huge cell', () => {
      const row: Record<string, unknown> = { huge: 'z'.repeat(50_000) };
      for (let i = 0; i < 400; i++) {
        row[`SomeFairlyLongColumnName_${i}`] = `value-${i}-abcdef`;
      }
      const result = limitResponseSize(
        {
          data: [row],
          metadata: {
            rowCount: 1,
            isPartial: false,
            requestedLimit: 20,
            hasMoreResults: false,
          },
        },
        { maxLength: 12000, minRows: 1, format: 'json' },
      );
      const parsed = JSON.parse(result.content);
      expect(parsed.data[0].SomeFairlyLongColumnName_399).toBe(
        'value-399-abcdef',
      );
      expect(parsed.data[0].huge).toMatch(/truncated \d+ chars\]$/);
      expect(result.content.length).toBeLessThan(40_000);
    });

    test('a wide row plus many huge cells stays bounded', () => {
      const row: Record<string, unknown> = {};
      for (let i = 0; i < 400; i++) {
        row[`SomeFairlyLongColumnName_${i}`] = `value-${i}-abcdef`;
      }
      for (let i = 0; i < 100; i++) row[`huge_${i}`] = 'z'.repeat(50_000);
      const result = limitResponseSize(
        {
          data: [row],
          metadata: {
            rowCount: 1,
            isPartial: false,
            requestedLimit: 20,
            hasMoreResults: false,
          },
        },
        { maxLength: 12000, minRows: 1, format: 'json' },
      );
      const parsed = JSON.parse(result.content);
      expect(parsed.data[0].SomeFairlyLongColumnName_399).toBe(
        'value-399-abcdef',
      );
      expect(parsed.data[0].huge_99).toMatch(/truncated \d+ chars\]$/);
      expect(result.content.length).toBeLessThan(50_000);
    });

    test('minRows above the available rows reports only delivered rows', () => {
      const result = limitResponseSize(giantRow(), {
        maxLength: 12000,
        minRows: 5,
        format: 'json',
      });
      expect(result.optimalRowCount).toBe(1);
      expect(result.content.length).toBeLessThanOrEqual(12000);
    });
  });
});
