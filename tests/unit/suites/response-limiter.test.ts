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
});
