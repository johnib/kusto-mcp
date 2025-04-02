# Kusto MCP Server Technical Context

## Technology Stack

### Core Technologies
- **Language**: TypeScript 5.0+
- **Runtime**: Node.js 16+
- **Package Manager**: npm 8+
- **Build System**: TypeScript Compiler (tsc)

### Key Dependencies

#### Azure Integration
```json
{
  "@azure/identity": "^3.1.3",
  "azure-kusto-data": "^3.2.0",
  "azure-kusto-ingest": "^3.2.0"
}
```
- Azure Identity for authentication
- Kusto Data for query operations
- Kusto Ingest for data operations

#### MCP Framework
```json
{
  "@modelcontextprotocol/sdk": "^1.0.0"
}
```
- Core MCP server implementation
- Protocol standardization
- Tool management

#### Telemetry & Monitoring
```json
{
  "@opentelemetry/api": "^1.4.1",
  "@opentelemetry/exporter-trace-otlp-http": "^0.39.1",
  "@opentelemetry/resources": "^1.12.0",
  "@opentelemetry/sdk-trace-base": "^1.12.0",
  "@opentelemetry/sdk-trace-node": "^1.12.0",
  "@opentelemetry/semantic-conventions": "^1.12.0"
}
```
- Distributed tracing
- Performance monitoring
- Operation tracking

#### Utility Libraries
```json
{
  "axios": "^1.4.0",
  "dotenv": "^16.0.3",
  "lru-cache": "^9.1.1",
  "zod": "^3.21.4",
  "zod-to-json-schema": "^3.20.4"
}
```
- HTTP client capabilities
- Environment configuration
- Caching implementation
- Schema validation
- JSON Schema generation

## Development Environment

### Required Tools
- Node.js (v16.0.0 or higher)
- npm (v8.0.0 or higher)
- TypeScript
- Azure CLI (for testing)
- Git

### IDE Configuration
- TypeScript support
- ESLint integration
- Prettier formatting
- Jest test runner
- Debug configuration

### Environment Variables
```bash
# Authentication
KUSTO_AUTH_METHOD=azure-cli  # Options: azure-identity, azure-cli

# Performance
KUSTO_QUERY_TIMEOUT=60000    # Timeout in milliseconds

# Telemetry (Optional)
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317/v1/traces
```

## Build & Development

### NPM Scripts
```json
{
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "ts-node --esm src/index.ts",
    "inspector": "npm run build && npx @modelcontextprotocol/inspector node dist/index.js",
    "test": "jest",
    "lint": "eslint src/**/*.ts",
    "format": "prettier --write src/**/*.ts"
  }
}
```

### Development Workflow
1. Clone repository
2. Install dependencies
3. Configure environment
4. Build project
5. Run tests
6. Start development server

## Testing Infrastructure

### Testing Tools
- Jest test runner
- TypeScript Jest
- ESLint
- Prettier

### Test Types
1. Unit Tests
2. Integration Tests
3. MCP Protocol Tests
4. Authentication Tests
5. Query Tests

## Deployment Requirements

### System Requirements
- Node.js runtime
- Azure subscription
- Network access to ADX
- Environment configuration

### Azure Requirements
- Azure Data Explorer cluster
- Authentication credentials
- Proper IAM setup
- Network access rules

## Performance Considerations

### Optimization Areas
1. Query execution
2. Schema caching
3. Connection pooling
4. Error handling
5. Memory management

### Monitoring Points
1. Query latency
2. Cache hit rates
3. Error frequencies
4. Authentication success
5. Resource usage

## Security Configuration

### Authentication Setup
1. Azure CLI configuration
2. Identity management
3. Token handling
4. Secret management

### Authorization
1. Role assignments
2. Resource access
3. Operation permissions
4. Scope limitations

## Maintenance Procedures

### Regular Tasks
1. Dependency updates
2. Security patches
3. Performance monitoring
4. Log analysis
5. Cache management

### Troubleshooting
1. Authentication issues
2. Connection problems
3. Query failures
4. Performance degradation
5. Memory leaks
