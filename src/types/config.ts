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
   * The response format for query results
   */
  responseFormat?: ResponseFormat;

  /**
   * Maximum characters per cell in markdown tables
   */
  markdownMaxCellLength?: number;
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: Partial<KustoConfig> = {
  authMethod: AuthenticationMethod.AzureIdentity,
  queryTimeout: 60000, // 1 minute
  responseFormat: ResponseFormat.Json, // Default to JSON for backward compatibility
  markdownMaxCellLength: 1000, // Default to 1000 characters per cell
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
