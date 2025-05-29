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
   git clone https://github.com/johnib/kusto-mcp
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

### Visual Studio Code Insiders configuration

Add this JSON stanza to the `settings.json` file:

```JSON
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
   - Runs KQL queries and returns results with automatic result limiting
   - Parameters:
     - `query`: The query to execute
     - `limit` (optional): Maximum number of rows to return (default: 20)
   - Features:
     - Automatically limits results to prevent context window overflow
     - Detects when results are partial and provides guidance
     - Returns metadata indicating if more results are available
     - Suggests using aggregations or filters for large datasets

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

## Testing

### End-to-End Tests

The project includes comprehensive E2E tests that run against a real Kusto cluster:

```bash
# Run all E2E tests
npm run test:e2e

# Run with debug output
npm run test:e2e:debug

# Run in watch mode
npm run test:e2e:watch
```

The E2E tests:

- Test against `https://help.kusto.windows.net/ContosoSales`
- Run the MCP server as a subprocess
- Verify MCP protocol compliance
- Test all tool operations with real data
- Validate error handling scenarios

For detailed testing documentation, see [tests/e2e/README.md](tests/e2e/README.md).

### Unit Tests

Run unit tests:

```bash
npm test
```

## CI/CD

This project uses GitHub Actions for automated testing, building, and publishing to NPM.

### Automated Publishing

The project is configured with semantic release for automated versioning and publishing:

- **On push to main**: Automatically runs tests, builds, and publishes to NPM based on conventional commit messages
- **Version bumping**: Uses semantic versioning based on commit message types:
  - `fix:` → Patch version (1.1.1 → 1.1.2)
  - `feat:` → Minor version (1.1.1 → 1.2.0)
  - `BREAKING CHANGE:` → Major version (1.1.1 → 2.0.0)
- **Skip publishing**: Add `[skip ci]` to commit message to skip publishing (useful for docs/config changes)
- **Automatic changelog**: Generates release notes from commit messages

### Required Secrets

For the GitHub Actions to work, the following secrets must be configured in your GitHub repository:

- `NPM_TOKEN`: Your NPM authentication token for publishing packages

### Workflows

1. **Release Workflow** (`.github/workflows/release.yml`):
   - Triggers on pushes to main branch
   - Runs tests and builds the project
   - Uses semantic-release for versioning and publishing
   - Creates GitHub releases with auto-generated notes

2. **CI Workflow** (`.github/workflows/ci.yml`):
   - Triggers on pull requests
   - Runs linting, tests, and builds
   - Ensures code quality before merging

### Conventional Commits

To ensure proper versioning, use conventional commit messages:

```bash
# For bug fixes (patch version)
git commit -m "fix: resolve connection timeout issue"

# For new features (minor version)  
git commit -m "feat: add new query optimization tool"

# For breaking changes (major version)
git commit -m "feat: redesign authentication system

BREAKING CHANGE: authentication configuration format has changed"

# For documentation (no version bump)
git commit -m "docs: update installation instructions"
```

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
├── tests/                 # Test files
│   └── e2e/              # End-to-end tests
│       ├── config.ts     # Test configuration
│       ├── helpers/      # Test utilities
│       ├── fixtures/     # Test data
│       └── suites/       # Test suites
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
