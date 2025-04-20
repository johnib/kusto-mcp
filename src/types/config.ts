/**
 * Authentication methods supported by the Kusto MCP server
 */
export enum AuthenticationMethod {
  AzureCli = 'azure-cli',
  AzureIdentity = 'azure-identity',
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
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: Partial<KustoConfig> = {
  authMethod: AuthenticationMethod.AzureIdentity,
  queryTimeout: 60000, // 1 minute
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
