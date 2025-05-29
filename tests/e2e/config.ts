import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Configuration for E2E tests against real Kusto cluster
 */
export const E2E_TEST_CONFIG = {
  // Test cluster and database
  cluster: 'https://help.kusto.windows.net/',
  database: 'ContosoSales',

  // Timeouts
  serverTimeout: 30000,
  queryTimeout: 60000,
  connectionTimeout: 10000,

  // Authentication
  // authMethod: 'azure-cli', // Require Azure CLI setup for tests

  // Server configuration
  serverBinary: 'dist/index.js', // Built server binary
  serverArgs: [], // Additional args for server

  // Test behavior
  maxRetries: 3,
  retryDelay: 1000,

  // Query limits for testing
  defaultQueryLimit: 20,
  testQueryLimit: 5, // Smaller limit for tests
} as const;

/**
 * Test environment validation
 */
export function validateTestEnvironment(): void {
  // Check if server binary exists
  const serverPath = path.resolve(E2E_TEST_CONFIG.serverBinary);
  if (!fs.existsSync(serverPath)) {
    throw new Error(
      `Server binary not found at ${serverPath}. Run 'npm run build' first.`,
    );
  }

  // Check if Azure CLI is available
  try {
    execSync('az --version', { stdio: 'ignore' });
  } catch (error) {
    throw new Error(
      'Azure CLI not found. Please install and authenticate with Azure CLI.',
    );
  }
}

/**
 * Get test environment variables
 */
export function getTestEnv(): Record<string, string> {
  return {
    NODE_ENV: 'test',
    KUSTO_AUTH_METHOD: E2E_TEST_CONFIG.authMethod,
    KUSTO_QUERY_TIMEOUT: E2E_TEST_CONFIG.queryTimeout.toString(),
    // Disable OpenTelemetry for tests
    OTEL_EXPORTER_OTLP_ENDPOINT: '',
  };
}
