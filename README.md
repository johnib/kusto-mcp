# Kusto MCP Server

A TypeScript implementation of a Model Context Protocol (MCP) server for Azure Data Explorer (Kusto), enabling AI assistants to interact with Kusto databases through a standardized protocol.

## Features

- **Azure Authentication**: Supports Azure CLI and Azure Identity authentication methods
- **Kusto Operations**:
  - Initialize connection to ADX clusters
  - List tables in databases
  - Show table schemas
  - Execute KQL queries
- **Schema Caching**: Caches table schemas to reduce redundant calls
- **Telemetry**: OpenTelemetry integration for activity tracking
- **Error Handling**: Comprehensive error handling with detailed exceptions
- **Type Safety**: Full TypeScript type definitions

## Prerequisites

- Node.js 16.x or higher
- npm 8.x or higher
- Access to an Azure Data Explorer (Kusto) cluster
- Azure CLI or Azure Identity for authentication

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/kusto-mcp.git
   cd kusto-mcp
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the project:
   ```bash
   npm run build
   ```

## Configuration

Create a `.env` file based on the provided `.env.example`:

```bash
# Kusto Configuration
KUSTO_CLUSTER_URL=https://your-cluster.kusto.windows.net
KUSTO_DEFAULT_DATABASE=your-database
KUSTO_AUTH_METHOD=azure-identity  # Options: azure-identity, azure-cli
KUSTO_TOKEN_ENDPOINT=http://localhost:5000/token
KUSTO_QUERY_TIMEOUT=60000  # Timeout in milliseconds (default: 60000)
KUSTO_ENABLE_SCHEMA_CACHE=true  # Enable schema caching (default: true)
KUSTO_SCHEMA_CACHE_TTL=1800000  # Cache TTL in milliseconds (default: 1800000)

# OpenTelemetry Configuration
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317/v1/traces
```

## Usage

### Running the Server

Start the server:

```bash
npm start
```

For development with auto-restart:

```bash
npm run dev
```

### MCP Tools

The server provides the following MCP tools:

1. **initialize-connection**
   - Creates a connection to an ADX cluster
   - Parameters:
     - `cluster_url`: The URL of the Kusto cluster
     - `database`: The database to connect to

2. **show-tables**
   - Lists tables in the given database
   - Parameters:
     - `database`: The database to list tables from

3. **show-table**
   - Shows the table schema columns
   - Parameters:
     - `tableName`: The name of the table to get the schema for

4. **execute-query**
   - Runs KQL queries and returns results
   - Parameters:
     - `query`: The query to execute

## Authentication

### Azure Identity Authentication

The server uses Azure Identity authentication by default. This requires:

1. A running token service at the configured endpoint (default: http://localhost:5000/token)
2. The token service should accept a POST request with a JSON body containing a `value` property with the scope
3. The token service should return a JSON response with `token` and `expiresOn` properties

### Azure CLI Authentication

To use Azure CLI authentication:

1. Set `KUSTO_AUTH_METHOD=azure-cli` in your `.env` file
2. Ensure you're logged in with Azure CLI (`az login`)

## Development

### Project Structure

```
kusto-mcp/
├── src/
│   ├── index.ts           # Entry point
│   ├── server.ts          # MCP server implementation
│   ├── auth/              # Authentication handlers
│   │   └── token-credentials.ts
│   ├── common/            # Common utilities
│   │   ├── errors.ts      # Error handling
│   │   └── utils.ts       # Utility functions
│   ├── operations/        # Kusto operations
│   │   └── kusto/
│   │       ├── connection.ts
│   │       ├── tables.ts
│   │       ├── queries.ts
│   │       └── index.ts
│   └── types/             # TypeScript type definitions
│       ├── config.ts
│       └── kusto-interfaces.ts
├── dist/                  # Compiled JavaScript
├── .env.example           # Example environment variables
├── package.json           # Project manifest
└── tsconfig.json          # TypeScript configuration
```

### Adding New Operations

To add a new Kusto operation:

1. Create a new file in `src/operations/kusto/` or extend an existing one
2. Define the operation function
3. Export the function from `src/operations/kusto/index.ts`
4. Add the tool to the server in `src/server.ts`

## License

[MIT](LICENSE)
