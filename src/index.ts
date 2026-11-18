#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { randomUUID } from 'node:crypto';
import {
  criticalLog,
  debugLog,
  installStderrErrorGuard,
} from './common/utils.js';
import { loadOrCreateMachineId } from './common/machine-id.js';
import {
  SeverityNumber,
  emitLog,
  recordProcessFatal,
  shutdownOtel,
  startTelemetry,
  watchStdoutForDisconnect,
} from './common/telemetry.js';
import {
  parseAuthMethod,
  parseBoolSetting,
  parseIntSetting,
  withScheme,
} from './common/config-parse.js';
import { MIN_RESPONSE_LENGTH } from './common/response-limiter.js';
import { configStateAttributes } from './common/config-state.js';
import { createShutdown, settlePendingCancels } from './common/shutdown.js';
import { killRunningAzChildren } from './auth/az-cli-credential.js';
import { createKustoServer } from './server.js';
import { VERSION } from './common/version.js';
import {
  AuthenticationMethod,
  KustoConfig,
  ResponseFormat,
} from './types/config.js';

// Guard stderr before anything can write to it: once the client disconnects,
// an unguarded EPIPE here spins the process at ~100% CPU forever (#180, #196).
installStderrErrorGuard();

// Note stdout's own write failure, so a client disconnect is reported as an
// exit rather than a crash (#365). Observes only; the error still exits as before.
watchStdoutForDisconnect();

// Log startup information
debugLog('Kusto MCP Server - Starting up');

// Settings that were set but unusable; logged now and shown with a failed
// connect's message, since hosts rarely show stderr (#288, #289).
const configWarnings: string[] = [];

// Determine the authentication method from environment variables
const authMethod = parseAuthMethod(
  process.env.KUSTO_AUTH_METHOD,
  configWarnings,
);
criticalLog(
  authMethod === AuthenticationMethod.AzureCli
    ? 'Using Azure CLI authentication'
    : 'Using Azure Identity authentication',
);

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
// (default off for backward compatibility).
const enableQueryStatistics = parseBoolSetting(
  'KUSTO_ENABLE_QUERY_STATISTICS',
  process.env.KUSTO_ENABLE_QUERY_STATISTICS,
  configWarnings,
  { unset: false, unknown: false },
);
criticalLog(
  enableQueryStatistics
    ? 'Query statistics extraction enabled'
    : 'Query statistics extraction disabled',
);

// Determine prompts feature flag from environment variables (default on).
const enablePrompts = parseBoolSetting(
  'KUSTO_ENABLE_PROMPTS',
  process.env.KUSTO_ENABLE_PROMPTS,
  configWarnings,
  { unset: true, unknown: false },
);
criticalLog(enablePrompts ? 'MCP prompts enabled' : 'MCP prompts disabled');

// Determine read-only enforcement from environment variables. Writes are
// allowed when unset; false/0/no/off/n/disabled run read-only. An
// unrecognised value also runs read-only (with a warning): a user who set the
// variable most likely meant to restrict writes (#287).
const allowWriteOperations = parseBoolSetting(
  'KUSTO_ALLOW_WRITE_OPERATIONS',
  process.env.KUSTO_ALLOW_WRITE_OPERATIONS,
  configWarnings,
  { unset: true, unknown: false },
);
criticalLog(
  allowWriteOperations
    ? 'Write/management commands enabled'
    : 'Running in READ-ONLY mode (write/management commands disabled)',
);

// Create the server configuration from environment variables
const config: KustoConfig = {
  authMethod: authMethod,
  queryTimeout: parseIntSetting(
    'KUSTO_QUERY_TIMEOUT',
    process.env.KUSTO_QUERY_TIMEOUT,
    configWarnings,
  ),
  connectionTimeout: parseIntSetting(
    'KUSTO_CONNECTION_TIMEOUT',
    process.env.KUSTO_CONNECTION_TIMEOUT,
    configWarnings,
  ),
  responseFormat: responseFormat,
  markdownMaxCellLength: parseIntSetting(
    'KUSTO_MARKDOWN_MAX_CELL_LENGTH',
    process.env.KUSTO_MARKDOWN_MAX_CELL_LENGTH,
    configWarnings,
    { max: Number.MAX_SAFE_INTEGER },
  ),
  // Below the limiter's minimum, every query would fail after it ran.
  maxResponseLength: parseIntSetting(
    'KUSTO_MAX_RESPONSE_LENGTH',
    process.env.KUSTO_MAX_RESPONSE_LENGTH,
    configWarnings,
    { min: MIN_RESPONSE_LENGTH, max: Number.MAX_SAFE_INTEGER },
  ),
  minRowsInResponse: parseIntSetting(
    'KUSTO_MIN_RESPONSE_ROWS',
    process.env.KUSTO_MIN_RESPONSE_ROWS,
    configWarnings,
    { min: 0, max: Number.MAX_SAFE_INTEGER },
  ),
  // A bare host (no https://) gets the scheme instead of failing as 'unknown'.
  clusterUrl: process.env.KUSTO_CLUSTER_URL?.trim()
    ? withScheme(process.env.KUSTO_CLUSTER_URL)
    : undefined,
  configWarnings,
  defaultDatabase:
    process.env.KUSTO_DEFAULT_DATABASE &&
    process.env.KUSTO_DEFAULT_DATABASE.trim()
      ? process.env.KUSTO_DEFAULT_DATABASE.trim()
      : undefined,
  enableQueryStatistics: enableQueryStatistics,
  enablePrompts: enablePrompts,
  allowWriteOperations: allowWriteOperations,
};

for (const warning of configWarnings) criticalLog(`Config warning: ${warning}`);
if (
  process.env.KUSTO_CLUSTER_URL?.trim() &&
  config.clusterUrl !== process.env.KUSTO_CLUSTER_URL.trim()
) {
  criticalLog(`KUSTO_CLUSTER_URL has no scheme; using ${config.clusterUrl}`);
}

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
// Telemetry is ALWAYS ON: using kusto-mcp reports anonymous usage metrics to the
// maintainer's Honeycomb (see common/telemetry.ts). No personal/organization
// data, query text, or results are collected. There is no disable switch; you
// can redirect to your own collector via OTEL_EXPORTER_OTLP_ENDPOINT/HEADERS.
const machine = loadOrCreateMachineId();

const resource = resourceFromAttributes({
  [ATTR_SERVICE_NAME]: 'kusto-mcp',
  'service.version': VERSION,
  'service.instance.id': randomUUID(),
  'host.arch': process.arch,
  'os.type': process.platform,
  'process.runtime.version': process.version,
  'kustomcp.runtime.node_major': Number(process.versions.node.split('.')[0]),
  'kustomcp.config.auth_method': String(authMethod),
  'kustomcp.config.response_format': String(responseFormat),
  'kustomcp.config.allow_write': allowWriteOperations,
  'kustomcp.config.query_statistics': enableQueryStatistics,
  'kustomcp.config.prompts_enabled': enablePrompts,
  'kustomcp.config.autoconnect': autoConnect,
  ...configStateAttributes(process.env),
  'machine.id': machine.machineId,
  // false: the id couldn't be saved, so every launch is a "new" machine.
  'kustomcp.machine.id_persisted': machine.persisted,
  'kustomcp.machine.first_seen': machine.firstSeen,
  'kustomcp.install.has_connected': machine.hasConnected,
});

// Telemetry is strictly best-effort — a failure to initialize it (e.g. a broken
// exporter dep) must never prevent the MCP server from starting.
try {
  await startTelemetry(resource);
} catch (error) {
  debugLog(
    `Telemetry init failed (continuing without it): ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
}

if (machine.isFirstRun) {
  criticalLog(
    'kusto-mcp reports anonymous usage telemetry (tool usage, latency, error ' +
      'types, version/OS, a random install id, and salted one-way hashes of ' +
      'your Azure tenant/user id for distinct counts) to the maintainer. No ' +
      'query text, results, or raw identity are collected, except an optional ' +
      '`purpose` hint, which is sent as written. See README > Telemetry.',
  );
}

// Create the server
const server = createKustoServer(config);

// Coordinated shutdown. A stdio MCP server is typically killed by the client
// closing stdin. Closing the server first makes the SDK abort in-flight tool
// calls, so a running execute-query sends `.cancel query` to the cluster
// instead of being left running (#333); those requests get a short bounded
// drain, then telemetry is flushed and the process exits. A running `az` is
// killed with its whole process tree, or it would outlive the server (#443).
// Never throws, and always exits within the drain cap, the kill cap and the
// telemetry flush bound.
const shutdownAndExit = createShutdown({
  killChildren: () => killRunningAzChildren(),
  closeServer: () => server.close(),
  drainCancels: settlePendingCancels,
  flushTelemetry: shutdownOtel,
  exit: code => process.exit(code),
  log: criticalLog,
});

// Run the server
async function runServer() {
  // Connect the server to the stdio transport
  const transport = new StdioServerTransport();
  // Exit when the MCP client disconnects (closes the pipe). We listen on stdin
  // EOF directly rather than relying solely on transport.onclose: a hung
  // telemetry export holds a live socket that would otherwise keep the event
  // loop from draining, so the process must be told to shut down. shutdownAndExit
  // then force-exits within the bounded flush race regardless of pending sockets.
  const onDisconnect = () => void shutdownAndExit('client-disconnect');
  transport.onclose = onDisconnect;
  process.stdin.once('end', onDisconnect);
  process.stdin.once('close', onDisconnect);
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
  recordProcessFatal('uncaughtException', error);
  criticalLog(`Uncaught exception: ${error.message}`);
  criticalLog(error.stack || 'No stack trace available');
  void shutdownAndExit('uncaughtException', 1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', reason => {
  recordProcessFatal('unhandledRejection', reason);
  criticalLog(
    `Unhandled promise rejection: ${
      reason instanceof Error ? reason.message : String(reason)
    }`,
  );
  void shutdownAndExit('unhandledRejection', 1);
});
