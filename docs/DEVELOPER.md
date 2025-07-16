# Developer Documentation

This document contains technical information for developers who want to contribute to the Kusto MCP Server project, build from source, or understand the implementation details.

## Prerequisites

- Node.js 16.x or higher
- npm 8.x or higher
- Access to an Azure Data Explorer (Kusto) cluster
- Azure CLI or Azure Identity for authentication

## Development Setup

### Building from Source

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

### Running in Development Mode

Start the server in development mode with auto-restart:

```bash
npm run dev
```

For production:

```bash
npm start
```

### Testing

#### End-to-End Tests

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

For detailed testing documentation, see [tests/e2e/README.md](../tests/e2e/README.md).

#### Unit Tests

Run unit tests:

```bash
npm test
```

Run with coverage:

```bash
npm run test:unit:coverage
```

## Project Structure

```
kusto-mcp/
├── src/
│   ├── index.ts           # Entry point
│   ├── server.ts          # MCP server implementation
│   ├── auth/              # Authentication handlers
│   │   └── token-credentials.ts
│   ├── common/            # Common utilities
│   │   ├── errors.ts      # Error handling
│   │   ├── markdown-formatter.ts # Response formatting
│   │   ├── response-limiter.ts   # Response size limiting
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
│   ├── e2e/              # End-to-end tests
│   └── unit/             # Unit tests
├── docs/                  # Documentation
├── dist/                  # Compiled JavaScript
├── .env.example           # Example environment variables
├── package.json           # Project manifest
└── tsconfig.json          # TypeScript configuration
```

## Adding New Operations

To add a new Kusto operation:

1. Create a new file in `src/operations/kusto/` or extend an existing one
2. Define the operation function
3. Export the function from `src/operations/kusto/index.ts`
4. Add the tool to the server in `src/server.ts`

Example:

```typescript
// src/operations/kusto/new-operation.ts
export async function newOperation(client: KustoClient, params: NewOperationParams) {
  // Implementation
}

// src/operations/kusto/index.ts
export { newOperation } from './new-operation.js';

// src/server.ts
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'new-operation') {
    // Handle the new operation
  }
});
```

## MCP Tools Reference

The server provides the following MCP tools:

### initialize-connection

Creates a connection to an ADX cluster

**Parameters:**

- `cluster_url` (string): The URL of the Kusto cluster
- `database` (string): The database to connect to

### show-tables

Lists tables in the given database

**Parameters:** None

### show-table

Shows the table schema columns

**Parameters:**

- `tableName` (string): The name of the table to get the schema for

### execute-query

Runs KQL queries and returns results with automatic result limiting

**Parameters:**

- `query` (string): The query to execute
- `limit` (number, optional): Maximum number of rows to return (default: 20)

**Features:**

- Automatically limits results to prevent context window overflow
- Detects when results are partial and provides guidance
- Returns metadata indicating if more results are available
- Suggests using aggregations or filters for large datasets

### show-functions

Lists all functions in the given database

**Parameters:** None

### show-function

Provides detailed information on a given function, including its source code

**Parameters:**

- `functionName` (string): The name of the function to get information about

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

## Code Quality

### Linting and Formatting

The project uses ESLint and Prettier for code quality:

```bash
# Check linting
npm run lint:check

# Fix linting issues
npm run lint:fix

# Check formatting
npm run format:check

# Fix formatting
npm run format:fix
```

### Pre-commit Hooks

The project uses Husky for pre-commit hooks that automatically:

- Run ESLint with auto-fixing
- Run Prettier with auto-formatting
- Block commits if there are unfixable linting errors

For more details, see [docs/pre-commit-hooks.md](pre-commit-hooks.md).

## Implementation Notes

This TypeScript implementation mirrors the functionality of the C# version while using the appropriate Node.js libraries:

- Uses `azure-kusto-data` and `azure-kusto-ingest` packages for Kusto operations
- Implements Azure CLI authentication using `KustoConnectionStringBuilder.withAzLoginIdentity`
- Provides comprehensive error handling with detailed exceptions
- Includes OpenTelemetry integration for activity tracking
- Implements schema caching to reduce redundant calls
- Uses TypeScript for type safety and better developer experience

## Authentication Implementation

### Azure Identity Authentication

The server uses Azure Identity authentication by default.

### Azure CLI Authentication

To use Azure CLI authentication:

1. Set `KUSTO_AUTH_METHOD=azure-cli` in your `.env` file
2. Ensure you're logged in with Azure CLI (`az login`)

## AI Assistant Guidance

This MCP server includes detailed guidance for AI assistants on how to effectively interact with users when working with Azure Data Explorer. The guidance includes:

- **Workflow Guidance**: Step-by-step instructions for connection setup, database exploration, query execution, best practices, and query optimization
- **Conversation Flow**: Suggestions for how to guide users through the interaction, from initial connection to executing analytical queries
- **Error Handling**: Common error scenarios and how to address them
- **ADX KQL Specifics**: Best practices for writing efficient KQL queries

This guidance helps ensure that AI assistants can provide a consistent, helpful experience when helping users interact with Azure Data Explorer through this MCP server.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests for new functionality
5. Ensure all tests pass
6. Run linting and formatting
7. Submit a pull request

Please follow the conventional commit format for your commit messages.

## License

[MIT](../LICENSE)
