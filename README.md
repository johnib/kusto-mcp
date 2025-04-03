# Kusto MCP Server

A TypeScript implementation of a Model Context Protocol (MCP) server for Azure Data Explorer (Kusto), enabling AI assistants to interact with Kusto databases through a standardized protocol.

## Features

- **Azure Authentication**: Supports Azure CLI and Azure Identity authentication methods
- **Kusto Operations**:
  - Initialize connection to ADX clusters
  - List tables in databases
  - Show table schemas
  - List functions in databases
  - Get code for functions
  - Execute KQL queries
- **Schema Caching**: Caches table schemas to reduce redundant calls
- **Telemetry**: OpenTelemetry integration for activity tracking
- **Error Handling**: Comprehensive error handling with detailed exceptions
- **Type Safety**: Full TypeScript type definitions
- **AI Assistant Guidance**: Detailed description for AI assistants on how to effectively interact with users when working with Azure Data Explorer

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
KUSTO_AUTH_METHOD=azure-cli  # Options: azure-identity, azure-cli
KUSTO_QUERY_TIMEOUT=60000  # Timeout in milliseconds (default: 60000)

# OpenTelemetry Configuration (optional)
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317/v1/traces
```

### CLINE MCP configuration

Add this JSON to the `cline_mcp_settings.json` file:

```JSON
{
  "mcpServers": {
    "kusto-mcp": {
      "command": "node",
      "args": [
        "<path to repo>/kusto-mcp/dist/index.js"
      ],
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

### Visual Studio Code Insiders configuration

Add this JSON stanza to the `settings.json` file:

```JSON
    "mcp": {
        "servers": {
            "kusto-mcp": {
                "type": "stdio",
                "command": "npm",
                "args": [
                    "--prefix",
                    "<path to the kusto-mcp source directory>",
                    "run",
                    "start",
                    "--silent"
                ]
            }
        }
    },

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

3. **show-table**
   - Shows the table schema columns
   - Parameters:
     - `tableName`: The name of the table to get the schema for

4. **execute-query**
   - Runs KQL queries and returns results
   - Parameters:
     - `query`: The query to execute

5. **show-functions**
   - Lists all functions in the given database

6. **show-function**
   - Provides detailed information on a given function, including its source code
   - Parameters:
     - `functionName`: The name of the function to get informationabout

### AI Assistant Guidance

This MCP server includes detailed guidance for AI assistants on how to effectively interact with users when working with Azure Data Explorer. The guidance includes:

- **Workflow Guidance**: Step-by-step instructions for connection setup, database exploration, query execution, best practices, and query optimization
- **Conversation Flow**: Suggestions for how to guide users through the interaction, from initial connection to executing analytical queries
- **Error Handling**: Common error scenarios and how to address them
- **ADX KQL Specifics**: Best practices for writing efficient KQL queries

This guidance helps ensure that AI assistants can provide a consistent, helpful experience when helping users interact with Azure Data Explorer through this MCP server.

## Authentication

### Azure Identity Authentication

The server uses Azure Identity authentication by default.

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

## Implementation Notes

This TypeScript implementation mirrors the functionality of the C# version while using the appropriate Node.js libraries:

- Uses `azure-kusto-data` and `azure-kusto-ingest` packages for Kusto operations
- Implements Azure CLI authentication using `KustoConnectionStringBuilder.withAzLoginIdentity`
- Provides comprehensive error handling with detailed exceptions
- Includes OpenTelemetry integration for activity tracking
- Implements schema caching to reduce redundant calls
- Uses TypeScript for type safety and better developer experience

## License

[MIT](LICENSE)
