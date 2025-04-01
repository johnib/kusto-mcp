#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import * as dotenv from "dotenv";
import { safeLog } from "./common/utils.js";
import { createKustoServer, testConnection } from "./server.js";
import { AuthenticationMethod, KustoConfig } from "./types/config.js";

// Load environment variables
dotenv.config();

// Configure OpenTelemetry
const provider = new NodeTracerProvider({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: "kusto-mcp"
  })
});

// Add OTLP exporter if configured
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  const exporter = new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  });
  
  provider.addSpanProcessor(new BatchSpanProcessor(exporter));
  safeLog(`OpenTelemetry exporter configured with endpoint: ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}`);
} else {
  safeLog("OpenTelemetry exporter not configured, skipping");
}

// Register the provider
provider.register();

// Log startup information
safeLog("Kusto MCP Server - Starting up");

// Determine the authentication method from environment variables
let authMethod = AuthenticationMethod.AzureIdentity; // Default to Azure Identity
safeLog("Using Azure Identity authentication by default");

if (process.env.KUSTO_AUTH_METHOD) {
  const method = process.env.KUSTO_AUTH_METHOD.toLowerCase();
  
  if (method === "azure-identity") {
    authMethod = AuthenticationMethod.AzureIdentity;
    safeLog("Using Azure Identity authentication");
  } else if (method === "azure-cli") {
    authMethod = AuthenticationMethod.AzureCli;
    safeLog("Using Azure CLI authentication");
  } else {
    safeLog(`Unknown authentication method: ${method}, falling back to Azure Identity`);
  }
}

// Create the server configuration from environment variables
const config: KustoConfig = {
  clusterUrl: process.env.KUSTO_CLUSTER_URL || "",
  defaultDatabase: process.env.KUSTO_DEFAULT_DATABASE,
  authMethod: authMethod,
  tokenEndpoint: process.env.KUSTO_TOKEN_ENDPOINT,
  queryTimeout: process.env.KUSTO_QUERY_TIMEOUT ? parseInt(process.env.KUSTO_QUERY_TIMEOUT) : undefined,
  enableSchemaCache: process.env.KUSTO_ENABLE_SCHEMA_CACHE !== "false",
  schemaCacheTtl: process.env.KUSTO_SCHEMA_CACHE_TTL ? parseInt(process.env.KUSTO_SCHEMA_CACHE_TTL) : undefined
};

// Validate the required configuration
if (!config.clusterUrl) {
  safeLog("Error: KUSTO_CLUSTER_URL environment variable is required");
  process.exit(1);
}

// Create the server
const server = createKustoServer(config);

// Run the server
async function runServer() {
  // Test the connection to Kusto if a default database is provided
  if (config.defaultDatabase) {
    const connectionSuccessful = await testConnection(config);
    
    if (!connectionSuccessful) {
      safeLog("Error: Failed to connect to Kusto cluster");
      process.exit(1);
    }
    
    safeLog("Successfully connected to Kusto cluster");
    safeLog(`Cluster URL: ${config.clusterUrl}`);
    safeLog(`Default Database: ${config.defaultDatabase}`);
    safeLog(`Authentication Method: ${config.authMethod}`);
  } else {
    safeLog("No default database provided, skipping connection test");
    safeLog("Connection will be initialized on first use");
  }
  
  // Connect the server to the stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  safeLog("Kusto MCP Server running on stdio");
}

// Start the server
runServer().catch(error => {
  safeLog(`Fatal error in main(): ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

// Handle process termination
process.on("SIGINT", () => {
  safeLog("Received SIGINT, shutting down");
  process.exit(0);
});

process.on("SIGTERM", () => {
  safeLog("Received SIGTERM, shutting down");
  process.exit(0);
});

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  safeLog(`Uncaught exception: ${error.message}`);
  safeLog(error.stack || "No stack trace available");
  process.exit(1);
});

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason) => {
  safeLog(`Unhandled promise rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
  process.exit(1);
});
