// Add Node.js specific Error interface
declare global {
  interface ErrorConstructor {
    captureStackTrace(
      targetObject: object,
      constructorOpt?: new (...args: unknown[]) => unknown,
    ): void;
  }
}

/**
 * Base error class for Kusto MCP server
 */
export class KustoMcpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    // Use Error.captureStackTrace if available (Node.js environment)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
}

/**
 * Error thrown when there's an issue with the Kusto connection
 */
export class KustoConnectionError extends KustoMcpError {
  constructor(message: string) {
    super(`Connection error: ${message}`);
  }
}

/**
 * Error thrown when authentication fails
 */
export class KustoAuthenticationError extends KustoMcpError {
  constructor(message: string) {
    super(`Authentication error: ${message}`);
  }
}

/**
 * Error thrown when a query execution fails
 */
export class KustoQueryError extends KustoMcpError {
  constructor(message: string) {
    super(message);
  }
}

/**
 * Error thrown when a resource is not found
 */
export class KustoResourceNotFoundError extends KustoMcpError {
  constructor(message: string) {
    super(`Resource not found: ${message}`);
  }
}

/**
 * Error thrown when input validation fails
 */
export class KustoValidationError extends KustoMcpError {
  constructor(message: string) {
    super(`Validation error: ${message}`);
  }
}

/**
 * Error thrown when there's an issue with data conversion
 */
export class KustoDataConversionError extends KustoMcpError {
  constructor(message: string) {
    super(`Data conversion error: ${message}`);
  }
}

/**
 * Error thrown when a timeout occurs
 */
export class KustoTimeoutError extends KustoMcpError {
  constructor(message: string) {
    super(`Timeout error: ${message}`);
  }
}

/**
 * Check if an error is a KustoMcpError
 */
export function isKustoMcpError(error: unknown): error is KustoMcpError {
  return error instanceof KustoMcpError;
}

/**
 * Configuration for retry logic
 */
export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  backoffMultiplier: number;
}

/**
 * Default retry configuration
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 100,
  backoffMultiplier: 2,
};

/**
 * Check if an error is transient (retryable)
 */
export function isTransientError(error: unknown): boolean {
  if (!error) return false;

  // Handle different error formats
  let errorMessage = '';
  let statusCode: number | undefined;

  if (error instanceof Error) {
    errorMessage = error.message.toLowerCase();
  } else if (typeof error === 'string') {
    errorMessage = error.toLowerCase();
  }

  // Extract status code from error object if available
  if (error && typeof error === 'object') {
    const errorObj = error as any;

    // Check various common status code properties
    statusCode = errorObj.status || errorObj.statusCode || errorObj.code;

    // Check nested response object (common in HTTP libraries)
    if (errorObj.response && typeof errorObj.response === 'object') {
      statusCode = statusCode || errorObj.response.status || errorObj.response.statusCode;
    }
  }

  // Check for specific HTTP status codes that are transient
  if (statusCode) {
    const transientStatusCodes = [
      429, // Too Many Requests (Rate Limit)
      502, // Bad Gateway
      503, // Service Unavailable
      504, // Gateway Timeout
      408, // Request Timeout
      520, // Web Server Returned an Unknown Error
      521, // Web Server Is Down
      522, // Connection Timed Out
      523, // Origin Is Unreachable
      524, // A Timeout Occurred
    ];

    if (transientStatusCodes.includes(statusCode)) {
      return true;
    }
  }

  // Check for network-related error messages
  const transientErrorPatterns = [
    'timeout',
    'timed out',
    'connection refused',
    'connection reset',
    'connection aborted',
    'network is unreachable',
    'host is unreachable',
    'no route to host',
    'temporary failure',
    'service unavailable',
    'server is busy',
    'rate limit',
    'throttle',
    'throttled',
    'enotfound', // DNS resolution failure
    'econnreset', // Connection reset by peer
    'econnrefused', // Connection refused
    'etimedout', // Connection timed out
    'socket hang up',
    'socket timeout',
    'request timeout',
    'gateway timeout',
    'bad gateway',
    'server overloaded',
    'retry after',
    'try again',
    'temporarily unavailable',
  ];

  return transientErrorPatterns.some(pattern => errorMessage.includes(pattern));
}

/**
 * Check if an error is permanent (non-retryable)
 */
export function isPermanentError(error: unknown): boolean {
  if (!error) return false;

  let errorMessage = '';
  let statusCode: number | undefined;

  if (error instanceof Error) {
    errorMessage = error.message.toLowerCase();
  } else if (typeof error === 'string') {
    errorMessage = error.toLowerCase();
  }

  // Extract status code from error object
  if (error && typeof error === 'object') {
    const errorObj = error as any;
    statusCode = errorObj.status || errorObj.statusCode || errorObj.code;

    if (errorObj.response && typeof errorObj.response === 'object') {
      statusCode = statusCode || errorObj.response.status || errorObj.response.statusCode;
    }
  }

  // Check for specific HTTP status codes that are permanent
  if (statusCode) {
    const permanentStatusCodes = [
      400, // Bad Request
      401, // Unauthorized
      403, // Forbidden
      404, // Not Found
      405, // Method Not Allowed
      406, // Not Acceptable
      409, // Conflict
      410, // Gone
      413, // Payload Too Large
      414, // URI Too Long
      415, // Unsupported Media Type
      422, // Unprocessable Entity
    ];

    if (permanentStatusCodes.includes(statusCode)) {
      return true;
    }
  }

  // Check for permanent error patterns
  const permanentErrorPatterns = [
    'authentication failed',
    'unauthorized',
    'access denied',
    'permission denied',
    'forbidden',
    'not found',
    'invalid syntax',
    'syntax error',
    'malformed',
    'bad request',
    'invalid query',
    'invalid parameter',
    'validation error',
    'schema error',
    'type mismatch',
    'column does not exist',
    'table does not exist',
    'function does not exist',
    'database does not exist',
  ];

  return permanentErrorPatterns.some(pattern => errorMessage.includes(pattern));
}

/**
 * Sleep for a given number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate delay with exponential backoff and jitter
 */
export function calculateBackoffDelay(
  attempt: number,
  baseDelayMs: number,
  backoffMultiplier: number,
): number {
  // Exponential backoff: baseDelay * (backoffMultiplier ^ attempt)
  const exponentialDelay = baseDelayMs * Math.pow(backoffMultiplier, attempt);

  // Add jitter (random variation of ±25%)
  const jitterRange = exponentialDelay * 0.25;
  const jitter = (Math.random() - 0.5) * 2 * jitterRange;

  return Math.max(0, Math.floor(exponentialDelay + jitter));
}

/**
 * Retry wrapper for async operations with exponential backoff
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  retryConfig: RetryConfig = DEFAULT_RETRY_CONFIG,
  operationName = 'operation',
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      // On the last attempt, don't retry
      if (attempt === retryConfig.maxRetries) {
        break;
      }

      // Check if error is retryable
      if (isPermanentError(error)) {
        // Permanent errors should not be retried
        break;
      }

      if (!isTransientError(error)) {
        // If it's not explicitly transient but also not permanent,
        // treat as retryable for better reliability
      }

      // Calculate delay for next attempt
      const delay = calculateBackoffDelay(
        attempt,
        retryConfig.baseDelayMs,
        retryConfig.backoffMultiplier,
      );

      // Log retry attempt (using console.error for visibility)
      console.error(
        `${operationName} failed on attempt ${attempt + 1}/${retryConfig.maxRetries + 1}, ` +
        `retrying in ${delay}ms. Error: ${error instanceof Error ? error.message : String(error)}`
      );

      // Wait before retrying
      await sleep(delay);
    }
  }

  // If we get here, all retries failed
  throw lastError;
}

/**
 * Format a Kusto MCP error for display
 */
export function formatKustoMcpError(error: KustoMcpError): string {
  if (error instanceof KustoConnectionError) {
    return `Kusto Connection Error: ${error.message}`;
  } else if (error instanceof KustoAuthenticationError) {
    return `Kusto Authentication Error: ${error.message}`;
  } else if (error instanceof KustoQueryError) {
    return `Kusto Query Error: ${error.message}`;
  } else if (error instanceof KustoResourceNotFoundError) {
    return `Kusto Resource Not Found: ${error.message}`;
  } else if (error instanceof KustoValidationError) {
    return `Kusto Validation Error: ${error.message}`;
  } else if (error instanceof KustoDataConversionError) {
    return `Kusto Data Conversion Error: ${error.message}`;
  } else if (error instanceof KustoTimeoutError) {
    return `Kusto Timeout Error: ${error.message}`;
  } else {
    return `Kusto Error: ${error.message}`;
  }
}
