// Add Node.js specific Error interface
declare global {
  interface ErrorConstructor {
    captureStackTrace?(targetObject: object, constructorOpt?: Function): void;
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
    super(`Query error: ${message}`);
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
