# Kusto MCP Server - End-to-End Tests

This directory contains comprehensive End-to-End (E2E) tests for the Kusto MCP Server that test against a real Azure Data Explorer cluster.

## Overview

The E2E tests verify the complete functionality of the MCP server by:

- Running the server as a subprocess
- Communicating via the MCP protocol over stdio
- Connecting to the real test cluster: `https://help.kusto.windows.net/`
- Testing against the `ContosoSales` sample database

## Test Structure

```
tests/e2e/
├── config.ts                  # Test configuration
├── setup.ts                   # Global test setup
├── README.md                  # This file
├── helpers/
│   ├── mcp-test-client.ts     # MCP protocol client
│   ├── server-manager.ts      # Server process management
│   └── test-assertions.ts     # Custom test assertions
├── fixtures/
│   └── test-queries.kql       # Sample KQL queries
└── suites/
    ├── connection.test.ts     # Connection management tests
    ├── table-operations.test.ts # Table listing and schema tests
    ├── function-operations.test.ts # Function operations tests
    ├── query-execution.test.ts # Query execution tests
    └── error-scenarios.test.ts # Error handling tests
```

## Prerequisites

### 1. Build the Server

```bash
npm run build
```

### 2. Azure CLI Authentication

Install and authenticate with Azure CLI:

```bash
# Install Azure CLI (if not already installed)
# See: https://docs.microsoft.com/en-us/cli/azure/install-azure-cli

# Login to Azure
az login

# Verify access to the test cluster
az kusto cluster show --name help --resource-group <resource-group>
```

### 3. Network Access

Ensure you can reach `https://help.kusto.windows.net/` from your environment.

## Running Tests

### Run All E2E Tests

```bash
npm run test:e2e
```

### Run with Debug Output

```bash
npm run test:e2e:debug
```

### Run in Watch Mode

```bash
npm run test:e2e:watch
```

### Run with Coverage

```bash
npm run test:e2e:coverage
```

### Run Specific Test Suite

```bash
# Connection tests only
npx jest tests/e2e/suites/connection.test.ts

# Query execution tests only
npx jest tests/e2e/suites/query-execution.test.ts
```

## Test Configuration

The tests are configured in `config.ts`:

```typescript
export const E2E_TEST_CONFIG = {
  cluster: 'https://help.kusto.windows.net/',
  database: 'ContosoSales',
  serverTimeout: 30000,
  queryTimeout: 60000,
  authMethod: 'azure-cli',
  // ... other settings
};
```

## Test Suites

### 1. Connection Tests (`connection.test.ts`)

- Server startup and shutdown
- MCP protocol initialization
- Connection to test cluster
- Authentication handling
- Invalid connection scenarios

### 2. Table Operations (`table-operations.test.ts`)

- Listing tables in database
- Getting table schemas
- Schema caching verification
- Error handling for non-existent tables

### 3. Function Operations (`function-operations.test.ts`)

- Listing database functions
- Getting function details and code
- Function validation
- Error handling

### 4. Query Execution (`query-execution.test.ts`)

- Simple data queries
- Aggregation queries
- Management commands (`.show tables`)
- Result limiting and pagination
- Time-based queries
- Schema exploration

### 5. Error Scenarios (`error-scenarios.test.ts`)

- Invalid KQL syntax
- Non-existent tables/functions
- Authentication failures
- Network timeouts
- Malformed requests
- Parameter validation

## Key Features Tested

### MCP Protocol Compliance

- JSON-RPC message handling
- Tool registration and listing
- Request/response formatting
- Error message structure

### Kusto Integration

- Azure authentication
- Database connections
- Query execution
- Schema retrieval
- Result formatting

### Error Handling

- Graceful failure modes
- Meaningful error messages
- Network resilience
- Input validation

### Performance

- Query timeouts
- Result limiting
- Caching effectiveness
- Memory management

## Test Utilities

### MCPTestClient

Handles MCP protocol communication:

```typescript
const client = new MCPTestClient();
await client.startServer();
const response = await client.callTool('show-tables', {});
await client.stopServer();
```

### ServerManager

Manages server subprocess lifecycle:

```typescript
const manager = new ServerManager();
const process = await manager.spawnServer();
await manager.killServer();
```

### Custom Assertions

Specialized assertions for MCP responses:

```typescript
assertConnectionSuccess(response);
assertTablesListResponse(response);
assertQueryExecutionResponse(response);
assertErrorMessage(response, 'Expected error');
```

## Troubleshooting

### Server Startup Issues

```bash
# Check if server binary exists
ls -la dist/index.js

# Rebuild if necessary
npm run build

# Check Azure CLI authentication
az account show
```

### Authentication Failures

```bash
# Re-authenticate with Azure CLI
az login

# Check access to test cluster
az kusto database show --cluster-name help --name ContosoSales
```

### Network Issues

```bash
# Test connectivity to cluster
curl -I https://help.kusto.windows.net/

# Check DNS resolution
nslookup help.kusto.windows.net
```

### Debug Server Output

```bash
# Run with debug logging
DEBUG_SERVER=1 npm run test:e2e

# Check server logs in test output
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DEBUG_SERVER` | Enable server debug output | `false` |
| `KUSTO_AUTH_METHOD` | Authentication method | `azure-cli` |
| `KUSTO_QUERY_TIMEOUT` | Query timeout (ms) | `60000` |

## Sample Test Run

```bash
$ npm run test:e2e

> kusto-mcp@1.1.1 test:e2e
> npm run build && jest tests/e2e --testTimeout=120000

PASS tests/e2e/suites/connection.test.ts
PASS tests/e2e/suites/table-operations.test.ts
PASS tests/e2e/suites/query-execution.test.ts
PASS tests/e2e/suites/function-operations.test.ts
PASS tests/e2e/suites/error-scenarios.test.ts

Test Suites: 5 passed, 5 total
Tests:       42 passed, 42 total
Snapshots:   0 total
Time:        127.45 s
```

## Contributing

When adding new E2E tests:

1. **Follow the existing structure** - Put tests in appropriate suite files
2. **Use custom assertions** - Leverage the assertion helpers for consistency
3. **Handle both success and error cases** - Test positive and negative scenarios
4. **Clean up resources** - Ensure proper server shutdown in `afterEach`
5. **Document edge cases** - Add comments for complex test scenarios

## Known Limitations

- Tests run sequentially to avoid conflicts
- Requires network access to Azure
- Depends on ContosoSales sample data availability
- Some tests may be flaky due to network conditions

## Future Improvements

- Add performance benchmarks
- Implement retry mechanisms for flaky tests
- Add more complex query scenarios
- Test concurrent client connections
- Add load testing capabilities
