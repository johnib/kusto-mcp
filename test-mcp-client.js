#!/usr/bin/env node

/**
 * MCP Test Client - Primary tool for testing new features during development
 *
 * USAGE FOR AGENTS:
 * 1. Modify environment variables below to test different configurations
 * 2. Update the test query to validate specific functionality
 * 3. Add additional test scenarios with setTimeout delays if needed
 * 4. Run after building: npm run build && node test-mcp-client.js
 *
 * This script should be sufficient for testing any new MCP functionality.
 * Customize it rather than creating separate test scripts.
 */

// Simple MCP client to test execute-query tool
import { spawn } from 'child_process';

// Start the MCP server with environment variables for testing
const server = spawn('node', ['dist/index.js'], {
  env: {
    ...process.env,
    KUSTO_CLUSTER_URL: 'https://help.kusto.windows.net',
    KUSTO_DEFAULT_DATABASE: 'ContosoSales',
    KUSTO_LOG_LEVEL: 'debug',
    KUSTO_RESPONSE_FORMAT: 'markdown',
    KUSTO_ENABLE_QUERY_STATISTICS: 'true'  // Feature flag example - modify as needed
  },
  stdio: ['pipe', 'pipe', 'pipe']
});

// Send MCP messages
function sendMcpMessage(message) {
  server.stdin.write(JSON.stringify(message) + '\n');
}

// Handle responses
server.stdout.on('data', (data) => {
  const lines = data.toString().split('\n').filter(line => line.trim());
  lines.forEach(line => {
    try {
      const response = JSON.parse(line);
      console.log('MCP Response:', JSON.stringify(response, null, 2));
    } catch (e) {
      console.log('Raw output:', line);
    }
  });
});

// Handle debug logs on stderr
server.stderr.on('data', (data) => {
  console.log('DEBUG:', data.toString());
});

// Initialize
sendMcpMessage({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' }
  }
});

// Initialize connection
setTimeout(() => {
  sendMcpMessage({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'initialize-connection',
      arguments: {
        cluster_url: 'https://help.kusto.windows.net',
        database: 'ContosoSales'
      }
    }
  });
}, 1000);

// Wait a bit then call execute-query
setTimeout(() => {
  sendMcpMessage({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'execute-query',
      arguments: {
        query: 'print 0',  // Modify this query to test specific scenarios
        limit: 5
      }
    }
  });
}, 3000);

// Cleanup after 10 seconds
setTimeout(() => {
  server.kill();
  process.exit(0);
}, 10000);