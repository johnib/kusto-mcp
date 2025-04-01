/**
 * Authentication methods supported by the Kusto MCP server
 */
export enum AuthenticationMethod {
  AzureCli = "azure-cli",
  AzureIdentity = "azure-identity"
}

/**
 * Configuration for the Kusto MCP server
 */
export interface KustoConfig {
  /**
   * The URL of the Kusto cluster
   */
  clusterUrl: string;
  
  /**
   * The default database to use
   */
  defaultDatabase?: string;
  
  /**
   * The authentication method to use
   */
  authMethod?: AuthenticationMethod;
  
  /**
   * The endpoint to get tokens from
   */
  tokenEndpoint?: string;
  
  /**
   * The timeout for Kusto queries in milliseconds
   */
  queryTimeout?: number;
  
  /**
   * Whether to enable schema caching
   */
  enableSchemaCache?: boolean;
  
  /**
   * The time to live for cached schema information in milliseconds
   */
  schemaCacheTtl?: number;
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: Partial<KustoConfig> = {
  authMethod: AuthenticationMethod.AzureIdentity,
  tokenEndpoint: "http://localhost:5000/token",
  queryTimeout: 60000, // 1 minute
  enableSchemaCache: true,
  schemaCacheTtl: 1800000 // 30 minutes
};

/**
 * Validate the Kusto configuration
 * 
 * @param config The configuration to validate
 * @returns The validated configuration with defaults applied
 */
export function validateConfig(config: Partial<KustoConfig>): KustoConfig {
  if (!config.clusterUrl) {
    throw new Error("Cluster URL is required");
  }
  
  // Apply defaults
  return {
    ...DEFAULT_CONFIG,
    ...config
  } as KustoConfig;
}
