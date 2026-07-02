#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { randomUUID } from 'node:crypto';
import { criticalLog, debugLog } from './common/utils.js';
import { loadOrCreateMachineId } from './common/machine-id.js';
import {
  SeverityNumber,
  emitLog,
  getTelemetryMode,
  shutdownOtel,
  startTelemetry,
} from './common/telemetry.js';
import { createKustoServer } from './server.js';
import { VERSION } from './common/version.js';
import {
  AuthenticationMethod,
  KustoConfig,
  ResponseFormat,
} from './types/config.js';

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

// Determine prompts feature flag from environment variables
let enablePrompts = true; // Default to true for new functionality
if (process.env.KUSTO_ENABLE_PROMPTS) {
  const value = process.env.KUSTO_ENABLE_PROMPTS.toLowerCase();
  enablePrompts = value === 'true' || value === '1' || value === 'yes';
  if (enablePrompts) {
    criticalLog('MCP prompts enabled');
  } else {
    criticalLog('MCP prompts disabled');
  }
} else {
  criticalLog('MCP prompts enabled by default');
}

// Determine read-only enforcement from environment variables. Writes are
// allowed by default; set KUSTO_ALLOW_WRITE_OPERATIONS=false to run read-only.
let allowWriteOperations = true;
if (process.env.KUSTO_ALLOW_WRITE_OPERATIONS) {
  const value = process.env.KUSTO_ALLOW_WRITE_OPERATIONS.toLowerCase();
  allowWriteOperations = !(
    value === 'false' ||
    value === '0' ||
    value === 'no'
  );
}
criticalLog(
  allowWriteOperations
    ? 'Write/management commands enabled (default)'
    : 'Running in READ-ONLY mode (write/management commands disabled)',
);

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
  clusterUrl:
    process.env.KUSTO_CLUSTER_URL && process.env.KUSTO_CLUSTER_URL.trim()
      ? process.env.KUSTO_CLUSTER_URL.trim()
      : undefined,
  defaultDatabase:
    process.env.KUSTO_DEFAULT_DATABASE &&
    process.env.KUSTO_DEFAULT_DATABASE.trim()
      ? process.env.KUSTO_DEFAULT_DATABASE.trim()
      : undefined,
  enableQueryStatistics: enableQueryStatistics,
  enablePrompts: enablePrompts,
  allowWriteOperations: allowWriteOperations,
};

// Log auto-connection configuration
const autoConnect = !!(config.clusterUrl && config.defaultDatabase);
if (autoConnect) {
  criticalLog(
    `Auto-connection configured: ${config.clusterUrl} -> ${config.defaultDatabase}`,
  );
} else if (config.clusterUrl || config.defaultDatabase) {
  criticalLog(
    'Partial auto-connection configuration detected (both KUSTO_CLUSTER_URL and KUSTO_DEFAULT_DATABASE required)',
  );
} else {
  criticalLog(
    'No auto-connection configuration detected, manual connection required',
  );
}

// --- OpenTelemetry -----------------------------------------------------------
// Anonymous usage telemetry ships to the maintainer's Honeycomb by default (see
// common/telemetry.ts). No personal or organization data is collected. Disable
// entirely with KUSTO_MCP_TELEMETRY=0.
const telemetryMode = getTelemetryMode();
const machine = telemetryMode.enabled ? loadOrCreateMachineId() : undefined;

const resource = resourceFromAttributes({
  [ATTR_SERVICE_NAME]: 'kusto-mcp',
  'service.version': VERSION,
  'service.instance.id': randomUUID(),
  'host.arch': process.arch,
  'os.type': process.platform,
  'process.runtime.version': process.version,
  'kustomcp.config.auth_method': String(authMethod),
  'kustomcp.config.response_format': String(responseFormat),
  'kustomcp.config.allow_write': allowWriteOperations,
  'kustomcp.config.query_statistics': enableQueryStatistics,
  'kustomcp.config.prompts_enabled': enablePrompts,
  'kustomcp.config.autoconnect': autoConnect,
  ...(machine && {
    'machine.id': machine.machineId,
    'kustomcp.machine.first_seen': machine.firstSeen,
  }),
});

await startTelemetry(resource);

if (machine?.isFirstRun) {
  criticalLog(
    'kusto-mcp sends anonymous usage telemetry (tool usage, latency, error ' +
      'types, version/OS, and a random install id) to the maintainer. No ' +
      'personal or organization data, query text, or results are ever ' +
      'collected. Disable with KUSTO_MCP_TELEMETRY=0. See README > Telemetry.',
  );
}

// Create the server
const server = createKustoServer(config);

// Coordinated shutdown that always flushes telemetry before exit. A stdio MCP
// server is typically killed by the client closing stdin, so buffered spans/
// metrics/logs would be lost without an awaited flush.
let shuttingDown = false;
async function shutdownAndExit(reason: string, code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  criticalLog(`Shutting down (${reason})`);
  await shutdownOtel();
  process.exit(code);
}

// Run the server
async function runServer() {
  // Connect the server to the stdio transport
  const transport = new StdioServerTransport();
  // Flush telemetry when the MCP client closes the pipe.
  transport.onclose = () => void shutdownAndExit('transport-close');
  await server.connect(transport);

  criticalLog('Kusto MCP Server running on stdio');
  emitLog(SeverityNumber.INFO, 'INFO', 'Kusto MCP server started', {
    'service.version': VERSION,
    'kustomcp.config.autoconnect': autoConnect,
  });
}

// Start the server
runServer().catch(error => {
  criticalLog(
    `Fatal error in main(): ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  void shutdownAndExit('fatal-error', 1);
});

// Handle process termination
process.on('SIGINT', () => void shutdownAndExit('SIGINT'));

process.on('SIGTERM', () => void shutdownAndExit('SIGTERM'));

// Handle uncaught exceptions
process.on('uncaughtException', error => {
  criticalLog(`Uncaught exception: ${error.message}`);
  criticalLog(error.stack || 'No stack trace available');
  void shutdownAndExit('uncaughtException', 1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', reason => {
  criticalLog(
    `Unhandled promise rejection: ${
      reason instanceof Error ? reason.message : String(reason)
    }`,
  );
  void shutdownAndExit('unhandledRejection', 1);
});
