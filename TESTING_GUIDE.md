# MCP Testing Guide

## Overview

This guide explains how to use the `test-mcp-client.js` script for testing MCP server functionality during development. This script is essential for validating that new features and changes work correctly before committing code.

## Why Use the Test Client

### Common Development Issues

- **Silent Failures**: Changes may not appear in final MCP responses due to pipeline complexity
- **Integration Problems**: Features may work in isolation but fail in the full MCP flow
- **Response Format Issues**: Markdown/JSON formatting may break with new fields
- **Connection Edge Cases**: Auto-connection vs manual connection behavior differences
- **Token Burning**: Manual testing through AI agents burns tokens during debugging

### Benefits of test-mcp-client.js

✅ **Fast feedback loop** - Immediate response validation
✅ **No token costs** - Direct MCP protocol testing
✅ **Real environment** - Tests actual Azure Data Explorer connection
✅ **Debug visibility** - Shows both MCP responses and debug logs
✅ **Reproducible** - Consistent test scenarios

## How to Use the Test Client

### 1. Basic Usage

```bash
# Build the project first
npm run build

# Run the test client (modify as needed for your feature)
node test-mcp-client.js
```

### 2. Environment Configuration

**Agents should modify the environment variables in the script directly** to test different configurations:

```javascript
env: {
  KUSTO_CLUSTER_URL: 'https://help.kusto.windows.net',
  KUSTO_DEFAULT_DATABASE: 'ContosoSales',
  KUSTO_LOG_LEVEL: 'debug',
  KUSTO_RESPONSE_FORMAT: 'markdown',  // or 'json'
  KUSTO_ENABLE_QUERY_STATISTICS: 'true'  // Feature flag example - modify as needed
}
```

**Key principle**: Modify the script rather than creating separate test scripts.

### 3. Test Flow

The script follows this sequence:

1. **Initialize MCP Protocol** (`initialize` method)
2. **Create Connection** (`initialize-connection` tool)
3. **Execute Test Query** (`execute-query` tool with `print 0`)
4. **Display Results** (Both MCP responses and debug logs)
5. **Auto-cleanup** (Terminates after 10 seconds)

## When to Use During Development

### ✅ Always Test When

- **Adding new fields** to query responses
- **Modifying extraction logic** in `queries.ts`
- **Changing response formatting** in `markdown-formatter.ts`
- **Updating server integration** in `server.ts`
- **Implementing new MCP tools**
- **Changing error handling**

### ✅ Use for Feature Validation

- **Verify new metadata appears** in final response
- **Test both markdown and JSON formats**
- **Validate error scenarios**
- **Check performance impact**
- **Confirm backward compatibility**

### ✅ Before Committing

- **Run successful test** to ensure no regressions
- **Verify debug logs** show expected behavior
- **Test with different response formats**

## Understanding Test Output

### Successful Response Example

```json
{
  "result": {
    "content": [
      {
        "type": "text",
        "text": "| print_0 |\n| ------- |\n| 0       |\n\n**Query Results Summary:**\n- Rows returned: 1\n- Total limit: 5\n- Partial results: No\n- Has more results: No\n**Query Performance:**\n- Total CPU: 00:00:00\n- Execution time: 0s\n- Extents total: 0\n- Extents scanned: 0"
      }
    ]
  },
  "jsonrpc": "2.0",
  "id": 3
}
```

### What to Look For

✅ **MCP Protocol Success**: `"result"` field present (not `"error"`)
✅ **Content Returned**: `"content"` array with `"text"` field
✅ **Expected Data**: Your new fields appear in the response
✅ **Proper Formatting**: Markdown/JSON renders correctly
✅ **Debug Logs**: Show expected extraction behavior

### Error Response Example

```json
{
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Error: Connection not initialized. Please call initialize-connection first."
      }
    ],
    "isError": true
  },
  "jsonrpc": "2.0",
  "id": 3
}
```

## Customizing Tests for Your Feature

### Modify the Test Query

```javascript
// Change line 77-81 to test specific scenarios
sendMcpMessage({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: {
    name: 'execute-query',
    arguments: {
      query: 'StormEvents | take 3',  // Your test query here
      limit: 10
    }
  }
});
```

### Test Different Response Formats

```javascript
// Change line 13 for different formats
KUSTO_RESPONSE_FORMAT: 'json'  // or 'markdown'
```

### Add Multiple Test Scenarios

```javascript
// Add more test calls with different delays
setTimeout(() => {
  // Test scenario 2
  sendMcpMessage({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'show-tables',
      arguments: {}
    }
  });
}, 5000);
```

## Development Workflow Integration

### 1. Feature Development Cycle

```bash
# 1. Make your changes
vim src/operations/kusto/queries.ts

# 2. Build the project
npm run build

# 3. Test with MCP client
node test-mcp-client.js

# 4. Verify expected output
# Look for your new fields in the response

# 5. If issues found, debug and repeat
```

### 2. Debugging Failed Tests

#### Common Issues

- **Empty fields**: Check extraction logic in `queries.ts`
- **Missing metadata**: Verify server integration in `server.ts`
- **Format problems**: Check markdown formatter
- **Connection errors**: Verify Azure CLI authentication

#### Debug Steps

1. **Check debug logs** in stderr output
2. **Verify build succeeded** (`npm run build`)
3. **Test individual components** in isolation
4. **Add temporary debug fields** to trace data flow

### 3. Creating Test Variations

#### For New Extraction Fields

```javascript
// Add debug validation
setTimeout(() => {
  sendMcpMessage({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'execute-query',
      arguments: {
        query: 'StormEvents | where StartTime > ago(1d) | summarize count() by State | take 5',
        limit: 10
      }
    }
  });
}, 5000);
```

#### For Error Handling

```javascript
// Test error scenarios
setTimeout(() => {
  sendMcpMessage({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'execute-query',
      arguments: {
        query: 'InvalidTable | take 1',  // Intentional error
        limit: 5
      }
    }
  });
}, 7000);
```

## Continuous Integration

### Pre-commit Testing

```bash
#!/bin/bash
# Add to .git/hooks/pre-commit

echo "Running MCP integration test..."
npm run build
timeout 15s node test-mcp-client.js > test-output.log 2>&1

if grep -q "Total CPU\|Execution time" test-output.log; then
  echo "✅ MCP test passed - statistics extraction working"
  rm test-output.log
  exit 0
else
  echo "❌ MCP test failed - check test-output.log"
  exit 1
fi
```

### Automated Validation

```javascript
// Enhanced test client with validation
function validateResponse(response) {
  const content = response.result?.content?.[0]?.text;
  if (!content) return false;

  // Validate expected fields are present
  const hasPerformanceSection = content.includes('**Query Performance:**');
  const hasCpuInfo = content.includes('Total CPU:');
  const hasExecutionTime = content.includes('Execution time:');

  return hasPerformanceSection && hasCpuInfo && hasExecutionTime;
}
```

## Best Practices

### ✅ Do

- **Test after every significant change**
- **Verify both success and error scenarios**
- **Check debug logs for extraction behavior**
- **Test with realistic Kusto queries**
- **Validate response format consistency**

### ❌ Don't

- **Skip testing before commits**
- **Only test happy path scenarios**
- **Ignore debug log warnings**
- **Test with overly simple queries only**
- **Forget to test response format changes**

## Troubleshooting

### Common Problems and Solutions

#### 1. "Connection not initialized" Error

**Cause**: Auto-connection failed, manual initialization needed
**Solution**: Check Azure CLI authentication: `az account show`

#### 2. Empty queryStatistics in Response

**Cause**: Extraction logic not finding expected data
**Solution**: Add debug logging to `extractQueryStatistics()` function

#### 3. Test Client Hangs

**Cause**: MCP server process not responding
**Solution**: Kill existing processes: `pkill -f "node dist/index.js"`

#### 4. Port Already in Use

**Cause**: Previous test run didn't clean up
**Solution**: Wait a few seconds or restart terminal

#### 5. Authentication Errors

**Cause**: Azure CLI not logged in or expired
**Solution**: Run `az login` and retry

## Advanced Usage

### Testing Different Clusters

```javascript
// Modify environment variables
KUSTO_CLUSTER_URL: 'https://your-cluster.kusto.windows.net',
KUSTO_DEFAULT_DATABASE: 'YourDatabase',
```

### Performance Testing

```javascript
// Add timing measurements
const startTime = Date.now();
server.stdout.on('data', (data) => {
  const endTime = Date.now();
  console.log(`Response time: ${endTime - startTime}ms`);
  // ... rest of handler
});
```

### Bulk Testing

```javascript
// Test multiple queries in sequence
const testQueries = [
  'print "test1"',
  'StormEvents | take 1',
  'range x from 1 to 3 step 1'
];

testQueries.forEach((query, index) => {
  setTimeout(() => {
    sendMcpMessage({
      jsonrpc: '2.0',
      id: 10 + index,
      method: 'tools/call',
      params: {
        name: 'execute-query',
        arguments: { query, limit: 5 }
      }
    });
  }, 3000 + (index * 2000));
});
```

## Summary

The `test-mcp-client.js` is a critical development tool that:

- **Validates feature implementation** end-to-end
- **Prevents regression bugs** before they reach production
- **Saves development time** with fast feedback loops
- **Reduces token costs** by avoiding manual AI testing
- **Provides debugging visibility** through direct MCP protocol interaction

**Always use this tool as part of your development workflow to ensure robust, working implementations.**
