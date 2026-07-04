/**
 * Authentication methods supported by the Kusto MCP server
 */
export enum AuthenticationMethod {
  AzureCli = 'azure-cli',
  AzureIdentity = 'azure-identity',
}

/**
 * Response format options for query results
 */
export enum ResponseFormat {
  Json = 'json',
  Markdown = 'markdown',
}

/**
 * Configuration for the Kusto MCP server
 */
export interface KustoConfig {
  /**
   * The authentication method to use
   */
  authMethod?: AuthenticationMethod;

  /**
   * The timeout for Kusto queries in milliseconds
   */
  queryTimeout?: number;

  /**
   * Timeout for connection initialization (token acquisition + the `print now()`
   * validation round-trip) in milliseconds. Without this the underlying client
   * falls back to the library's 270s query default, so a bad cluster URL or a
   * hung auth can leave the server stuck for minutes.
   */
  connectionTimeout?: number;

  /**
   * The response format for query results
   */
  responseFormat?: ResponseFormat;

  /**
   * Maximum characters per cell in markdown tables
   */
  markdownMaxCellLength?: number;

  /**
   * Maximum total characters for entire MCP response
   */
  maxResponseLength?: number;

  /**
   * Minimum number of rows to return in response (when data exists)
   */
  minRowsInResponse?: number;

  /**
   * Optional cluster URL for automatic connection on startup
   */
  clusterUrl?: string;

  /**
   * Optional default database for automatic connection on startup
   */
  defaultDatabase?: string;

  /**
   * Enable extraction and display of query performance statistics
   * (CPU time, execution time, extents scanned, etc.)
   */
  enableQueryStatistics?: boolean;

  /**
   * Enable MCP prompts support
   */
  enablePrompts?: boolean;

  /**
   * Allow write/management commands (any non-".show" dot-command such as
   * .set, .append, .ingest, .drop). Enabled by default; set to false to run
   * the server in read-only mode and reject these commands.
   */
  allowWriteOperations?: boolean;
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: Partial<KustoConfig> = {
  authMethod: AuthenticationMethod.AzureIdentity,
  queryTimeout: 60000, // 1 minute
  connectionTimeout: 20000, // 20s — connection setup should be fast; bound the tail
  responseFormat: ResponseFormat.Json, // Default to JSON for backward compatibility
  markdownMaxCellLength: 1000, // Default to 1000 characters per cell
  maxResponseLength: 12000, // 12K characters - conservative for context windows
  minRowsInResponse: 1, // Always return at least 1 row if data exists
  enableQueryStatistics: false, // Disabled by default for backward compatibility
  enablePrompts: true, // Enable prompts by default
  allowWriteOperations: true, // Allow writes by default (set false for read-only)
};

/**
 * Validate the Kusto configuration
 *
 * @param config The configuration to validate
 * @returns The validated configuration with defaults applied
 */
export function validateConfig(config: Partial<KustoConfig>): KustoConfig {
  // Apply defaults
  return {
    ...DEFAULT_CONFIG,
    ...config,
  } as KustoConfig;
}
