import { classifyQueryShape } from './query-shape.js';

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
    super(message);
  }
}

/**
 * Error thrown when the MCP client cancels a request while a query is running
 */
export class KustoQueryCancelledError extends KustoMcpError {
  constructor(message: string) {
    super(message);
  }
}

/**
 * Check if an error is a KustoMcpError
 */
export function isKustoMcpError(error: unknown): error is KustoMcpError {
  return error instanceof KustoMcpError;
}

/**
 * Extract a human-readable message from an error thrown by the Kusto client.
 * Kusto surfaces the useful detail under `response.data.error['@message']` (or
 * `.message`); fall back to the plain Error message otherwise.
 */
export function extractKustoErrorMessage(error: unknown): string {
  let errorMessage = error instanceof Error ? error.message : String(error);

  if (error && typeof error === 'object' && 'response' in error) {
    const response = (error as { response?: unknown }).response as
      | { data?: { error?: { '@message'?: string; message?: string } } }
      | undefined;
    if (response?.data?.error?.['@message']) {
      errorMessage = response.data.error['@message'];
    } else if (response?.data?.error?.message) {
      errorMessage = response.data.error.message;
    }
  }

  return errorMessage;
}

const LONG_TIME_WINDOWS: ReadonlySet<unknown> = new Set([
  '<=7d',
  '<=30d',
  '>30d',
]);

/**
 * Append recovery advice to a timeout message for the agent (#312). The text
 * goes into the tool result only; it is never put on a span.
 */
export function withTimeoutHint(message: string, query: string): string {
  const shape = classifyQueryShape(query);
  // Management commands (`.show …`) have no time range or rows to narrow.
  if (String(shape['kustomcp.query.stmt_kind']).startsWith('control_')) {
    return message;
  }
  let hint =
    'Narrow the time range, filter earlier, or summarize before returning rows.';
  const window = shape['kustomcp.query.time_window'];
  if (LONG_TIME_WINDOWS.has(window)) {
    hint +=
      ' The query looks back more than 1 day; try a shorter window first.';
  }
  const base = message.trimEnd();
  return `${base.endsWith('.') ? base : `${base}.`} ${hint}`;
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
  } else if (error instanceof KustoQueryCancelledError) {
    return `Kusto Query Cancelled: ${error.message}`;
  } else {
    return `Kusto Error: ${error.message}`;
  }
}
