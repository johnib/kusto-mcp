#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import * as dotenv from 'dotenv';
import { criticalLog, debugLog } from './common/utils.js';
import { createKustoServer } from './server.js';
import {
  AuthenticationMethod,
  KustoConfig,
  ResponseFormat,
} from './types/config.js';

// Load environment variables
dotenv.config();

// Configure OpenTelemetry
const provider = new NodeTracerProvider({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: 'kusto-mcp',
  }),
});

// Add OTLP exporter if configured
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  const exporter = new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  });

  provider.addSpanProcessor(new BatchSpanProcessor(exporter));
  debugLog(
    `OpenTelemetry exporter configured with endpoint: ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}`,
  );
} else {
  debugLog('OpenTelemetry exporter not configured, skipping');
}

// Register the provider
provider.register();

// Log startup information
debugLog('Kusto MCP Server - Starting up');

// Determine the authentication method from environment variables
let authMethod = AuthenticationMethod.AzureIdentity; // Default to Azure Identity
criticalLog('Using Azure Identity authentication by default');

if (process.env.KUSTO_AUTH_METHOD) {
  const method = process.env.KUSTO_AUTH_METHOD.toLowerCase();

  if (method === 'azure-identity') {
    authMethod = AuthenticationMethod.AzureIdentity;
    criticalLog('Using Azure Identity authentication');
  } else if (method === 'azure-cli') {
    authMethod = AuthenticationMethod.AzureCli;
    criticalLog('Using Azure CLI authentication');
  } else {
    criticalLog(
      `Unknown authentication method: ${method}, falling back to Azure Identity`,
    );
  }
}

// Determine the response format from environment variables
let responseFormat = ResponseFormat.Json; // Default to JSON for backward compatibility
if (process.env.KUSTO_RESPONSE_FORMAT) {
  const format = process.env.KUSTO_RESPONSE_FORMAT.toLowerCase();
  if (format === 'json') {
    responseFormat = ResponseFormat.Json;
    criticalLog('Using JSON response format');
  } else if (format === 'markdown') {
    responseFormat = ResponseFormat.Markdown;
    criticalLog('Using Markdown response format');
  } else {
    criticalLog(`Unknown response format: ${format}, falling back to JSON`);
  }
}

// Determine query statistics feature flag from environment variables
let enableQueryStatistics = false; // Default to false for backward compatibility
if (process.env.KUSTO_ENABLE_QUERY_STATISTICS) {
  const value = process.env.KUSTO_ENABLE_QUERY_STATISTICS.toLowerCase();
  enableQueryStatistics = value === 'true' || value === '1' || value === 'yes';
  if (enableQueryStatistics) {
    criticalLog('Query statistics extraction enabled');
  } else {
    criticalLog('Query statistics extraction disabled');
  }
} else {
  criticalLog('Query statistics extraction disabled by default');
}

// Create the server configuration from environment variables
const config: KustoConfig = {
  authMethod: authMethod,
  queryTimeout: process.env.KUSTO_QUERY_TIMEOUT
    ? parseInt(process.env.KUSTO_QUERY_TIMEOUT)
    : undefined,
  responseFormat: responseFormat,
  markdownMaxCellLength: process.env.KUSTO_MARKDOWN_MAX_CELL_LENGTH
    ? parseInt(process.env.KUSTO_MARKDOWN_MAX_CELL_LENGTH)
    : undefined,
  maxResponseLength: process.env.KUSTO_MAX_RESPONSE_LENGTH
    ? parseInt(process.env.KUSTO_MAX_RESPONSE_LENGTH)
    : undefined,
  minRowsInResponse: process.env.KUSTO_MIN_RESPONSE_ROWS
    ? parseInt(process.env.KUSTO_MIN_RESPONSE_ROWS)
    : undefined,
  clusterUrl: process.env.KUSTO_CLUSTER_URL && process.env.KUSTO_CLUSTER_URL.trim() ? process.env.KUSTO_CLUSTER_URL.trim() : undefined,
  defaultDatabase: process.env.KUSTO_DEFAULT_DATABASE && process.env.KUSTO_DEFAULT_DATABASE.trim() ? process.env.KUSTO_DEFAULT_DATABASE.trim() : undefined,
  enableQueryStatistics: enableQueryStatistics,
};

// Log auto-connection configuration
if (config.clusterUrl && config.defaultDatabase) {
  criticalLog(`Auto-connection configured: ${config.clusterUrl} -> ${config.defaultDatabase}`);
} else if (config.clusterUrl || config.defaultDatabase) {
  criticalLog('Partial auto-connection configuration detected (both KUSTO_CLUSTER_URL and KUSTO_DEFAULT_DATABASE required)');
} else {
  criticalLog('No auto-connection configuration detected, manual connection required');
}

// Create the server
const server = createKustoServer(config);

// Run the server
async function runServer() {
  // Connect the server to the stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  criticalLog('Kusto MCP Server running on stdio');
}

// Start the server
runServer().catch(error => {
  criticalLog(
    `Fatal error in main(): ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exit(1);
});

// Handle process termination
process.on('SIGINT', () => {
  criticalLog('Received SIGINT, shutting down');
  process.exit(0);
});

process.on('SIGTERM', () => {
  criticalLog('Received SIGTERM, shutting down');
  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', error => {
  criticalLog(`Uncaught exception: ${error.message}`);
  criticalLog(error.stack || 'No stack trace available');
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', reason => {
  criticalLog(
    `Unhandled promise rejection: ${
      reason instanceof Error ? reason.message : String(reason)
    }`,
  );
  process.exit(1);
});
