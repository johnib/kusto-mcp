# Configuration Guide

This document covers all configuration options for the Kusto MCP Server.

## Environment Variables

Create a `.env` file based on the provided `.env.example`:

```bash
# Kusto Configuration
KUSTO_AUTH_METHOD=azure-cli  # Options: azure-identity, azure-cli
KUSTO_QUERY_TIMEOUT=60000  # Timeout in milliseconds (default: 60000)
KUSTO_RESPONSE_FORMAT=json  # Options: json, markdown (default: json)
KUSTO_MARKDOWN_MAX_CELL_LENGTH=1000  # Maximum characters per table cell (default: 1000)

# Global response size limiting
KUSTO_MAX_RESPONSE_LENGTH=12000  # Maximum characters for entire MCP response (default: 12000)
KUSTO_MIN_RESPONSE_ROWS=1  # Minimum rows to return when data exists (default: 1)

# OpenTelemetry Configuration (optional)
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317/v1/traces
```

## Authentication Methods

### Azure CLI Authentication (Recommended)

1. Set `KUSTO_AUTH_METHOD=azure-cli` in your `.env` file
2. Ensure you're logged in with Azure CLI:

   ```bash
   az login
   ```

### Azure Identity Authentication

The server uses Azure Identity authentication by default when `KUSTO_AUTH_METHOD` is not set or set to `azure-identity`.

## Response Formats

The server supports two response formats for query results:

### JSON Format (Default)

```json
{
  "name": "PrimaryResult",
  "data": [
    {"Column1": "value1", "Column2": "value2"},
    {"Column1": "value3", "Column2": "value4"}
  ],
  "metadata": {
    "rowCount": 2,
    "isPartial": false,
    "requestedLimit": 20,
    "hasMoreResults": false
  }
}
```

### Markdown Format

When `KUSTO_RESPONSE_FORMAT=markdown` is set, query results are returned as formatted markdown tables:

```markdown
## Query Results

| Column1 | Column2 |
|---------|---------|
| value1  | value2  |
| value3  | value4  |

**Metadata:**
- Rows returned: 2
- Partial results: false
- Requested limit: 20
- Has more results: false
```

The markdown format is particularly useful when working with AI assistants that can better interpret and present tabular data in a human-readable format.

### Markdown Table Character Limits

When using the markdown response format, you can control the maximum length of content in table cells using the `KUSTO_MARKDOWN_MAX_CELL_LENGTH` environment variable. This is particularly useful for preventing extremely wide tables when query results contain long text values.

**Configuration:**

```bash
# Set maximum characters per table cell (default: 1000)
KUSTO_MARKDOWN_MAX_CELL_LENGTH=500
```

**Examples:**

With `KUSTO_MARKDOWN_MAX_CELL_LENGTH=50`:

```markdown
| Short | Medium                                             | Long                                               |
| ----- | -------------------------------------------------- | -------------------------------------------------- |
| ABC   | This is a medium length string that should not... | This is a very long string that gets truncated... |
| DEF   | Another medium string that fits                    | Another very long string that should also be tr... |
```

**Features:**

- **Automatic Truncation**: Long content is automatically truncated with `...` ellipsis
- **Table Alignment**: The markdown-table library properly aligns columns even with truncated content
- **Configurable Limit**: Set any positive number for the character limit
- **Smart Formatting**: Uses the library's built-in `stringLength` option for proper table rendering
- **Backward Compatible**: When not configured, tables render without truncation (existing behavior)

**Use Cases:**

- **Compact Display**: Set to 100-200 characters for compact tables in chat interfaces
- **Detailed Analysis**: Set to 2000+ characters when you need to see full content
- **Context Window Management**: Prevent extremely large tables from overwhelming AI context windows
- **Disable Truncation**: Set to a very large number (e.g., 999999) to effectively disable truncation

## Global Response Size Limiting

Beyond cell-level truncation, the server provides intelligent global response limiting to prevent context window overflow while maximizing data utility. This feature dynamically reduces the number of rows returned to fit within a specified character limit.

**Configuration:**

```bash
# Set maximum characters for entire MCP response (default: 12000)
KUSTO_MAX_RESPONSE_LENGTH=8000

# Set minimum rows to return when data exists (default: 1)
KUSTO_MIN_RESPONSE_ROWS=3
```

**How It Works:**

The server uses a sophisticated binary search algorithm to find the optimal number of rows that fit within the character limit:

1. **Initial Assessment**: Checks if the full requested data fits within the limit
2. **Dynamic Reduction**: If too large, uses binary search to find the maximum rows that fit
3. **Minimum Guarantee**: Always returns at least `KUSTO_MIN_RESPONSE_ROWS` when data exists
4. **Smart Metadata**: Provides detailed information about the reduction process

**Example Response with Global Limiting:**

```json
{
  "name": "PrimaryResult", 
  "data": [
    {"EventTime": "2024-01-01T10:00:00Z", "CustomerID": "C001", "Revenue": 1250.50},
    {"EventTime": "2024-01-01T10:15:00Z", "CustomerID": "C002", "Revenue": 875.25},
    {"EventTime": "2024-01-01T10:30:00Z", "CustomerID": "C003", "Revenue": 2100.75}
  ],
  "metadata": {
    "rowCount": 3,
    "isPartial": true,
    "requestedLimit": 20,
    "hasMoreResults": true,
    "reducedForResponseSize": true,
    "originalRowsAvailable": 15,
    "globalCharLimit": 8000,
    "responseCharCount": 7856
  },
  "message": "Row count reduced to fit response size limit. Use more specific filters for larger datasets."
}
```

**Features:**

- **Binary Search Optimization**: Efficiently finds the optimal row count without testing every possibility
- **Format Awareness**: Works with both JSON and Markdown response formats
- **Metadata Transparency**: Clearly indicates when and why reduction occurred
- **Preservation Priority**: Maintains data structure and formatting while reducing volume
- **Performance**: Minimizes query re-execution through intelligent caching

**Use Cases:**

- **AI Context Management**: Prevent overwhelming language model context windows (8K-32K character limits)
- **Large Dataset Exploration**: Get meaningful samples from huge query results
- **Interactive Analysis**: Provide quick insights while suggesting refinement strategies
- **Progressive Disclosure**: Show initial results with clear indicators about available data
- **Response Optimization**: Balance information density with processing constraints

**Best Practices:**

- **Conservative Limits**: Start with 8000-12000 characters for most AI assistants
- **Minimum Rows**: Set to 1-5 rows to ensure meaningful results even from large datasets
- **Query Guidance**: The system automatically suggests using filters and aggregations for large results
- **Format Consideration**: Markdown format typically uses more characters than JSON

## OpenTelemetry Integration

The server supports OpenTelemetry for monitoring and tracing:

```bash
# Enable OpenTelemetry tracing
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317/v1/traces
```

When configured, the server will send trace data to your OpenTelemetry collector.

## Platform-Specific Configuration

### Cline

Add this to your `cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "github.com/johnib/kusto-mcp": {
      "command": "npx",
      "args": ["-y", "kusto-mcp"],
      "env": {},
      "disabled": false,
      "autoApprove": [
        "initialize-connection",
        "show-tables",
        "show-table",
        "execute-query"
      ]
    }
  }
}
```

### Visual Studio Code

Add this to your `settings.json`:

```json
{
  "mcp": {
    "servers": {
      "github.com/johnib/kusto-mcp": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "kusto-mcp"]
      }
    }
  }
}
```

### Claude Desktop

Add this to your Claude Desktop configuration file:

```json
{
  "mcpServers": {
    "kusto-mcp": {
      "command": "npx",
      "args": ["-y", "kusto-mcp"]
    }
  }
}
```

## Query Timeout Configuration

Control how long queries can run before timing out:

```bash
# Set query timeout to 2 minutes (default: 60000ms = 1 minute)
KUSTO_QUERY_TIMEOUT=120000
```

This is useful for:

- Long-running analytical queries
- Large dataset processing
- Preventing resource exhaustion

## Performance Tuning

### Schema Caching

The server automatically caches table schemas to reduce redundant calls. No configuration is needed - this happens automatically.

### Connection Management

The server maintains connection state for efficiency. Connections are automatically managed and don't require manual configuration.

## Security Considerations

### Environment Variables

- Store sensitive configuration in `.env` files
- Never commit `.env` files to version control
- Use environment-specific configuration for different deployments

### Authentication Tokens

- Azure CLI tokens are automatically managed
- Tokens are cached securely by the Azure SDK
- No manual token management is required

## Troubleshooting Configuration

### Common Issues

1. **Authentication Failures**
   - Verify `az login` status
   - Check Azure permissions for the target cluster
   - Ensure correct `KUSTO_AUTH_METHOD` setting

2. **Query Timeouts**
   - Increase `KUSTO_QUERY_TIMEOUT` for long queries
   - Optimize KQL queries for better performance
   - Consider using query result limiting

3. **Response Size Issues**
   - Adjust `KUSTO_MAX_RESPONSE_LENGTH` for your use case
   - Use `KUSTO_MIN_RESPONSE_ROWS` to ensure minimum data
   - Consider switching between JSON and Markdown formats

4. **OpenTelemetry Problems**
   - Verify OTLP endpoint is accessible
   - Check network connectivity to the collector
   - Ensure correct endpoint format (include /v1/traces)

### Debug Mode

For troubleshooting, you can enable debug output:

```bash
DEBUG_SERVER=1 npx kusto-mcp
```

This will provide additional logging to help diagnose issues.
