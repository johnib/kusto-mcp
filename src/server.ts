import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { formatKustoMcpError, isKustoMcpError } from './common/errors.js';
import { criticalLog, debugLog } from './common/utils.js';
import {
  executeQuery,
  KustoConnection,
  showFunction,
  showTable,
  showTables,
} from './operations/kusto/index.js';
import { showFunctions } from './operations/kusto/tables.js';
import { KustoConfig, validateConfig } from './types/config.js';

/**
 * Detailed description of the Kusto MCP server for AI assistants
 */
const KUSTO_TOOL_DESCRIPTION = `The assistant's goal is to help users interact with Azure Data Explorer (ADX) effectively.
Start by establishing the connection and maintain a helpful, conversational tone throughout the interaction.

<mcp>
Tools:
- "initialize-connection": Creates connection to an ADX cluster
- "show-tables": list tables in the current database
- "show-table": show the table schema columns
- "show-functions": list functions in the current database and their documentation
- "show-function": show details of a specific function, including its code and parameters
- "execute-query": Runs KQL queries and returns results
</mcp>

<workflow>
1. Connection Setup:
   - Ask for cluster URL and database name
   - Use Azure CLI authentication to connect
   - Store and display available databases

2. Database Exploration:
   - When user mentions data analysis needs, identify target database
   - Use show-tables to fetch tables information from the current database, and show-table to fetch table schema
   - Use show-functions to fetch functions information from the current database, and show-function to fetch function details (including code and parameters)
   - Present schema details in user-friendly format

3. Query Execution:
   - Parse user's analytical questions
   - Match questions to available data structures
   - Generate appropriate KQL queries
   - Execute queries and display results
   - Provide clear explanations of findings

4. Best Practices:
   - Cache schema information to avoid redundant calls
   - Use clear error handling and user feedback
   - Maintain context across multiple queries
   - Explain query logic when helpful

5. Query Optimization:
   - Use time filters efficiently
   - Leverage ADX's columnar structure
   - Apply appropriate aggregations
   - Consider materialized views when applicable
</workflow>

<conversation-flow>
1. Start with: "Would you like to connect to an ADX cluster? Please provide the cluster URL."

2. After connection:
   - Acknowledge success/failure
   - List available databases
   - Guide user toward data exploration

3. For each analytical question:
   - Confirm target database
   - Check/fetch schema if needed
   - Generate and execute appropriate KQL queries
   - Present results clearly
   - Visualize data when helpful

4. Maintain awareness of:
   - Previously fetched schemas
   - Current database context
   - Query history and insights
</conversation-flow>

<error-handling>
- Connection failures: Verify Azure CLI auth and cluster URL
- Schema errors: Verify database/table names
- Query errors: Provide clear explanation and correction steps
</error-handling>

Remember ADX KQL Specifics:
- Time-based queries are optimized with time filters
- Use 'ago()' for relative time ranges
- Leverage ADX's columnar structure for efficient queries
- Utilize ADX's built-in analytics functions
- Consider materialized views for frequent queries
- Use cross-cluster queries when needed`;

// Define schemas for tool parameters
const InitializeConnectionSchema = z.object({
  cluster_url: z.string().describe('The URL of the Kusto cluster'),
  database: z.string().describe('The database to connect to'),
});

const ShowTablesSchema = z.object({});
const ShowFunctionsSchema = z.object({});

const ShowTableSchema = z.object({
  tableName: z.string().describe('The name of the table to get the schema for'),
});

const ExecuteQuerySchema = z.object({
  query: z.string().describe('The query to execute'),
  limit: z
    .number()
    .optional()
    .default(20)
    .describe('Maximum number of rows to return (default: 20)'),
});

const ShowFunctionSchema = z.object({
  functionName: z
    .string()
    .describe('The name of the function to get details for'),
});

/**
 * Create a Kusto MCP server
 *
 * @param config The Kusto configuration
 * @returns A configured MCP server instance
 */
export function createKustoServer(config: KustoConfig): Server {
  // Validate the configuration
  const validatedConfig = validateConfig(config);

  // Initialize the MCP server
  const server = new Server(
    {
      name: 'kusto-mcp',
      version: '1.0.0',
      description: KUSTO_TOOL_DESCRIPTION,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // Declare a variable to store the connection when it's initialized
  let connection: KustoConnection | null = null;

  // Auto-connection function
  async function tryAutoConnect(): Promise<void> {
    // Only attempt auto-connection if both cluster URL and database are configured
    if (!validatedConfig.clusterUrl || !validatedConfig.defaultDatabase) {
      debugLog('Auto-connection skipped: missing cluster URL or database configuration');
      return;
    }

    try {
      debugLog(`Attempting auto-connection to ${validatedConfig.clusterUrl} -> ${validatedConfig.defaultDatabase}`);

      // Create a new connection
      const autoConnection = new KustoConnection(validatedConfig);

      // Initialize the connection
      const result = await autoConnection.initialize(
        validatedConfig.clusterUrl,
        validatedConfig.defaultDatabase
      );

      // If successful, store the connection
      connection = autoConnection;
      criticalLog(`Auto-connection successful: ${result.cluster} -> ${result.database}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      criticalLog(`Auto-connection failed: ${errorMessage}. Manual connection will be required.`);
      // Don't throw - just log and continue with manual connection mode
    }
  }

  // Register the ListTools request handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'initialize-connection',
          description: 'Creates connection to an ADX cluster',
          inputSchema: zodToJsonSchema(InitializeConnectionSchema),
        },
        {
          name: 'show-tables',
          description: 'List tables in the current database',
          inputSchema: zodToJsonSchema(ShowTablesSchema),
        },
        {
          name: 'show-table',
          description: 'Show the table schema columns',
          inputSchema: zodToJsonSchema(ShowTableSchema),
        },
        {
          name: 'execute-query',
          description:
            'Runs KQL queries and returns results. By default, limits results to 20 rows to prevent context overflow. Use the "limit" parameter to specify a different maximum. If results are marked as partial, consider revising your query to use aggregations, filters, or summarizations.',
          inputSchema: zodToJsonSchema(ExecuteQuerySchema),
        },
        {
          name: 'show-functions',
          description: 'List functions in the current database',
          inputSchema: zodToJsonSchema(ShowFunctionsSchema),
        },
        {
          name: 'show-function',
          description:
            'Show details of a specific function, including its code and parameters',
          inputSchema: zodToJsonSchema(ShowFunctionSchema),
        },
      ],
    };
  });

  // Register the CallTool request handler
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      if (!request.params.arguments) {
        throw new McpError(ErrorCode.InvalidParams, 'Arguments are required');
      }

      switch (request.params.name) {
        case 'initialize-connection': {
          const args = InitializeConnectionSchema.parse(
            request.params.arguments,
          );

          // Create a new connection each time initialize-connection is called
          // This will override any existing connection
          connection = new KustoConnection(validatedConfig);

          // Initialize the connection
          const result = await connection.initialize(
            args.cluster_url,
            args.database,
          );
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        }

        case 'show-tables': {
          ShowTablesSchema.parse(request.params.arguments);

          // Check if the connection is initialized
          if (!connection) {
            throw new McpError(
              ErrorCode.InvalidRequest,
              'Connection not initialized. Please call initialize-connection first.',
            );
          }

          const result = await showTables(connection);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        }

        case 'show-table': {
          const args = ShowTableSchema.parse(request.params.arguments);

          // Check if the connection is initialized
          if (!connection) {
            throw new McpError(
              ErrorCode.InvalidRequest,
              'Connection not initialized. Please call initialize-connection first.',
            );
          }

          const result = await showTable(connection, args.tableName);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        }

        case 'show-functions': {
          ShowFunctionsSchema.parse(request.params.arguments);
          // Check if the connection is initialized
          if (!connection) {
            throw new McpError(
              ErrorCode.InvalidRequest,
              'Connection not initialized. Please call initialize-connection first.',
            );
          }

          const result = await showFunctions(connection);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        }

        case 'execute-query': {
          const args = ExecuteQuerySchema.parse(request.params.arguments);

          // Check if the connection is initialized
          if (!connection) {
            throw new McpError(
              ErrorCode.InvalidRequest,
              'Connection not initialized. Please call initialize-connection first.',
            );
          }

          // Get user-requested limit and global response limit
          const requestedLimit = args.limit || 20;
          const globalCharLimit = validatedConfig.maxResponseLength || 12000;
          const minRows = validatedConfig.minRowsInResponse || 1;

          // Execute query with generous limit initially (for dynamic reduction)
          // Use a reasonable upper bound to avoid excessive data fetching
          const initialLimit = requestedLimit;
          const modifiedQuery = `${args.query} | take ${initialLimit + 1}`;

          // Import the transformation functions here to avoid auto-formatter issues
          const { executeQueryWithTransformation, transformQueryResult } =
            await import('./operations/kusto/index.js');
          const { limitResponseSize } = await import(
            './common/response-limiter.js'
          );

          // Execute the query and get raw results
          const rawResult = await executeQuery(connection, modifiedQuery);

          // Transform using the proper architecture
          const transformedResult = transformQueryResult(rawResult);

          // Detect if results are partial using N+1 approach
          const hasMoreDataAvailable =
            transformedResult.data.length > initialLimit;
          const availableData = hasMoreDataAvailable
            ? transformedResult.data.slice(0, initialLimit)
            : transformedResult.data;

          // Create base response structure with all available data
          const baseResponse = {
            name: transformedResult.name,
            data: availableData,
            metadata: {
              rowCount: 0, // Will be updated by response limiter
              isPartial:
                hasMoreDataAvailable || availableData.length > requestedLimit,
              requestedLimit,
              hasMoreResults:
                hasMoreDataAvailable || availableData.length > requestedLimit,
            },
            message: undefined, // Will be set by response limiter if needed
          };

          // Determine response format from config
          const responseFormat = validatedConfig.responseFormat || 'json';

          // Apply global response size limiting with dynamic row reduction
          const limitResult = limitResponseSize(baseResponse, {
            maxLength: globalCharLimit,
            minRows: minRows,
            format: responseFormat,
            formatOptions: {
              maxColumnWidth: validatedConfig.markdownMaxCellLength,
              showMetadata: true,
            },
          });

          debugLog(`Using ${responseFormat} response format`);
          debugLog(
            `Global response limiting: ${
              limitResult.wasReduced ? 'Applied' : 'Not needed'
            }`,
          );
          debugLog(
            `Optimal row count: ${limitResult.optimalRowCount} / ${limitResult.originalRowCount}`,
          );
          debugLog(
            `Final response size: ${limitResult.finalCharCount} / ${globalCharLimit} chars`,
          );

          return {
            content: [
              {
                type: 'text',
                text: limitResult.content,
              },
            ],
          };
        }

        case 'show-function': {
          const args = ShowFunctionSchema.parse(request.params.arguments);

          // Check if the connection is initialized
          if (!connection) {
            throw new McpError(
              ErrorCode.InvalidRequest,
              'Connection not initialized. Please call initialize-connection first.',
            );
          }

          const result = await showFunction(connection, args.functionName);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        }

        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${request.params.name}`,
          );
      }
    } catch (error) {
      criticalLog(`Error handling tool call: ${error}`);

      // Format the error message
      let errorMessage: string;

      if (error instanceof McpError) {
        errorMessage = `MCP Error: ${error.message}`;
      } else if (isKustoMcpError(error)) {
        errorMessage = formatKustoMcpError(error);
      } else {
        errorMessage = `Error: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }

      return {
        content: [{ type: 'text', text: errorMessage }],
        isError: true,
      };
    }
  });

  // Trigger auto-connection asynchronously (fire-and-forget)
  // This allows the server to start immediately while attempting connection in the background
  tryAutoConnect().catch(error => {
    // This catch is redundant since tryAutoConnect already handles errors,
    // but it's a safety net in case of unexpected issues
    criticalLog(`Unexpected error in auto-connection: ${error instanceof Error ? error.message : String(error)}`);
  });

  return server;
}
