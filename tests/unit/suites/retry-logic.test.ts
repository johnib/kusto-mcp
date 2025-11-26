/**
 * Unit tests for retry logic and error categorization
 * These tests verify the retry wrapper and error classification functions
 */

import {
  isTransientError,
  isPermanentError,
  withRetry,
  calculateBackoffDelay,
  sleep,
  RetryConfig,
} from '../../../src/common/errors.js';

describe('Retry Logic Unit Tests', () => {
  describe('Error Categorization', () => {
    describe('isTransientError', () => {
      test('should identify transient HTTP status codes', () => {
        const transientErrors = [
          { status: 429 }, // Too Many Requests
          { status: 502 }, // Bad Gateway
          { status: 503 }, // Service Unavailable
          { status: 504 }, // Gateway Timeout
          { status: 408 }, // Request Timeout
          { status: 520 }, // Web Server Returned an Unknown Error
          { status: 521 }, // Web Server Is Down
          { status: 522 }, // Connection Timed Out
          { status: 523 }, // Origin Is Unreachable
          { status: 524 }, // A Timeout Occurred
        ];

        for (const error of transientErrors) {
          expect(isTransientError(error)).toBe(true);
        }
      });

      test('should identify transient error messages', () => {
        const transientMessages = [
          'Connection timeout',
          'Request timed out',
          'Connection refused',
          'Connection reset by peer',
          'Network is unreachable',
          'Host is unreachable',
          'Service unavailable',
          'Server is busy',
          'Rate limit exceeded',
          'Throttled',
          'ENOTFOUND',
          'ECONNRESET',
          'ECONNREFUSED',
          'ETIMEDOUT',
          'Socket hang up',
          'Gateway timeout',
          'Bad gateway',
          'Server overloaded',
          'Retry after',
          'Try again later',
          'Temporarily unavailable',
        ];

        for (const message of transientMessages) {
          expect(isTransientError(new Error(message))).toBe(true);
        }
      });

      test('should identify transient errors in nested response objects', () => {
        const errorWithNestedResponse = {
          response: {
            status: 503,
            data: {
              error: {
                message: 'Service temporarily unavailable',
              },
            },
          },
        };

        expect(isTransientError(errorWithNestedResponse)).toBe(true);
      });

      test('should not identify permanent errors as transient', () => {
        const permanentErrors = [
          { status: 400 }, // Bad Request
          { status: 401 }, // Unauthorized
          { status: 403 }, // Forbidden
          { status: 404 }, // Not Found
          new Error('Authentication failed'),
          new Error('Invalid syntax'),
          new Error('Table does not exist'),
        ];

        for (const error of permanentErrors) {
          expect(isTransientError(error)).toBe(false);
        }
      });
    });

    describe('isPermanentError', () => {
      test('should identify permanent HTTP status codes', () => {
        const permanentErrors = [
          { status: 400 }, // Bad Request
          { status: 401 }, // Unauthorized
          { status: 403 }, // Forbidden
          { status: 404 }, // Not Found
          { status: 405 }, // Method Not Allowed
          { status: 409 }, // Conflict
          { status: 410 }, // Gone
          { status: 413 }, // Payload Too Large
          { status: 422 }, // Unprocessable Entity
        ];

        for (const error of permanentErrors) {
          expect(isPermanentError(error)).toBe(true);
        }
      });

      test('should identify permanent error messages', () => {
        const permanentMessages = [
          'Authentication failed',
          'Unauthorized',
          'Access denied',
          'Permission denied',
          'Forbidden',
          'Not found',
          'Invalid syntax',
          'Syntax error',
          'Malformed query',
          'Bad request',
          'Invalid query',
          'Invalid parameter',
          'Validation error',
          'Schema error',
          'Type mismatch',
          'Column does not exist',
          'Table does not exist',
          'Function does not exist',
          'Database does not exist',
        ];

        for (const message of permanentMessages) {
          expect(isPermanentError(new Error(message))).toBe(true);
        }
      });

      test('should identify permanent errors in nested response objects', () => {
        const errorWithNestedResponse = {
          response: {
            status: 401,
            data: {
              error: {
                message: 'Authentication failed',
              },
            },
          },
        };

        expect(isPermanentError(errorWithNestedResponse)).toBe(true);
      });

      test('should not identify transient errors as permanent', () => {
        const transientErrors = [
          { status: 429 }, // Too Many Requests
          { status: 503 }, // Service Unavailable
          new Error('Connection timeout'),
          new Error('Network error'),
        ];

        for (const error of transientErrors) {
          expect(isPermanentError(error)).toBe(false);
        }
      });
    });

    describe('Error Classification Edge Cases', () => {
      test('should handle null and undefined errors', () => {
        expect(isTransientError(null)).toBe(false);
        expect(isTransientError(undefined)).toBe(false);
        expect(isPermanentError(null)).toBe(false);
        expect(isPermanentError(undefined)).toBe(false);
      });

      test('should handle string errors', () => {
        expect(isTransientError('Connection timeout')).toBe(true);
        expect(isPermanentError('Authentication failed')).toBe(true);
      });

      test('should handle complex error objects', () => {
        const complexError = {
          name: 'NetworkError',
          message: 'Request timeout',
          code: 'ETIMEDOUT',
          response: {
            status: 408,
            statusText: 'Request Timeout',
          },
        };

        expect(isTransientError(complexError)).toBe(true);
        expect(isPermanentError(complexError)).toBe(false);
      });
    });
  });

  describe('Backoff Calculation', () => {
    test('should calculate exponential backoff correctly', () => {
      const baseDelay = 100;
      const multiplier = 2;

      // Attempt 0: ~100ms
      const delay0 = calculateBackoffDelay(0, baseDelay, multiplier);
      expect(delay0).toBeGreaterThanOrEqual(75);  // 100ms - 25% jitter
      expect(delay0).toBeLessThanOrEqual(125);    // 100ms + 25% jitter

      // Attempt 1: ~200ms
      const delay1 = calculateBackoffDelay(1, baseDelay, multiplier);
      expect(delay1).toBeGreaterThanOrEqual(150); // 200ms - 25% jitter
      expect(delay1).toBeLessThanOrEqual(250);    // 200ms + 25% jitter

      // Attempt 2: ~400ms
      const delay2 = calculateBackoffDelay(2, baseDelay, multiplier);
      expect(delay2).toBeGreaterThanOrEqual(300); // 400ms - 25% jitter
      expect(delay2).toBeLessThanOrEqual(500);    // 400ms + 25% jitter
    });

    test('should never return negative delays', () => {
      const delays = [];
      for (let i = 0; i < 10; i++) {
        delays.push(calculateBackoffDelay(i, 1, 2));
      }

      for (const delay of delays) {
        expect(delay).toBeGreaterThanOrEqual(0);
      }
    });

    test('should handle edge cases in backoff calculation', () => {
      // Zero base delay
      expect(calculateBackoffDelay(0, 0, 2)).toBe(0);

      // Multiplier of 1 (no exponential growth)
      const delay = calculateBackoffDelay(3, 100, 1);
      expect(delay).toBeGreaterThanOrEqual(75);
      expect(delay).toBeLessThanOrEqual(125);
    });
  });

  describe('Sleep Function', () => {
    test('should sleep for the specified duration', async () => {
      const start = Date.now();
      await sleep(50);
      const elapsed = Date.now() - start;

      // Allow for some timing variance
      expect(elapsed).toBeGreaterThanOrEqual(45);
      expect(elapsed).toBeLessThan(100);
    });

    test('should handle zero delay', async () => {
      const start = Date.now();
      await sleep(0);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(10); // Should be almost immediate
    });
  });

  describe('Retry Wrapper', () => {
    const mockRetryConfig: RetryConfig = {
      maxRetries: 2,
      baseDelayMs: 10, // Short delay for tests
      backoffMultiplier: 2,
    };

    test('should succeed on first attempt', async () => {
      const operation = jest.fn().mockResolvedValue('success');

      const result = await withRetry(operation, mockRetryConfig, 'test-operation');

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    test('should retry transient errors', async () => {
      const operation = jest.fn()
        .mockRejectedValueOnce(new Error('Connection timeout'))
        .mockResolvedValueOnce('success');

      const result = await withRetry(operation, mockRetryConfig, 'test-operation');

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(2);
    });

    test('should not retry permanent errors', async () => {
      const operation = jest.fn()
        .mockRejectedValue(new Error('Authentication failed'));

      await expect(withRetry(operation, mockRetryConfig, 'test-operation'))
        .rejects.toThrow('Authentication failed');

      expect(operation).toHaveBeenCalledTimes(1);
    });

    test('should respect max retry limit', async () => {
      const operation = jest.fn()
        .mockRejectedValue(new Error('Connection timeout'));

      await expect(withRetry(operation, mockRetryConfig, 'test-operation'))
        .rejects.toThrow('Connection timeout');

      // Initial attempt + 2 retries = 3 total calls
      expect(operation).toHaveBeenCalledTimes(3);
    });

    test('should handle unknown errors as retryable', async () => {
      const operation = jest.fn()
        .mockRejectedValueOnce(new Error('Unknown error'))
        .mockResolvedValueOnce('success');

      const result = await withRetry(operation, mockRetryConfig, 'test-operation');

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(2);
    });

    test('should use default config when not provided', async () => {
      const operation = jest.fn()
        .mockRejectedValueOnce(new Error('Connection timeout'))
        .mockResolvedValueOnce('success');

      const result = await withRetry(operation);

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(2);
    });

    test('should log retry attempts', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const operation = jest.fn()
        .mockRejectedValueOnce(new Error('Connection timeout'))
        .mockResolvedValueOnce('success');

      await withRetry(operation, mockRetryConfig, 'test-operation');

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('test-operation failed on attempt 1/3')
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Connection timeout')
      );

      consoleSpy.mockRestore();
    });

    test('should handle async operation failures correctly', async () => {
      const operation = async () => {
        await sleep(1);
        throw new Error('Async failure');
      };

      const operationSpy = jest.fn(operation);

      await expect(withRetry(operationSpy, { maxRetries: 1, baseDelayMs: 1, backoffMultiplier: 2 }))
        .rejects.toThrow('Async failure');

      expect(operationSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('Integration with Kusto Errors', () => {
    test('should correctly classify typical Kusto transient errors', () => {
      const kustoTransientErrors = [
        { message: 'Query timed out after 30000ms' },
        { response: { status: 503, data: { error: { '@message': 'Service temporarily unavailable' } } } },
        { message: 'Connection refused by server' },
        { message: 'ECONNRESET: Connection reset by peer' },
      ];

      for (const error of kustoTransientErrors) {
        expect(isTransientError(error)).toBe(true);
        expect(isPermanentError(error)).toBe(false);
      }
    });

    test('should correctly classify typical Kusto permanent errors', () => {
      const kustoPermanentErrors = [
        { message: 'Authentication failed: Invalid credentials' },
        { message: 'Syntax error: Invalid KQL query' },
        { message: 'Table "NonExistentTable" does not exist' },
        { response: { status: 401, data: { error: { '@message': 'Unauthorized access' } } } },
        { response: { status: 400, data: { error: { message: 'Invalid query syntax' } } } },
      ];

      for (const error of kustoPermanentErrors) {
        expect(isPermanentError(error)).toBe(true);
        expect(isTransientError(error)).toBe(false);
      }
    });
  });
});