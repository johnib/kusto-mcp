import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ListPromptsResult,
  GetPromptResult,
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
import { PromptManager } from './operations/prompts/index.js';
import { KustoConfig, validateConfig } from './types/config.js';

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
    },
    {
      capabilities: {
        tools: {},
        ...(validatedConfig.enablePrompts && { prompts: {} }),
      },
    },
  );

  // Declare a variable to store the connection when it's initialized
  let connection: KustoConnection | null = null;

  // Initialize the prompt manager
  const promptManager = validatedConfig.enablePrompts ? new PromptManager() : null;

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

  // Register the ListPrompts request handler
  server.setRequestHandler(ListPromptsRequestSchema, async request => {
    if (!validatedConfig.enablePrompts || !promptManager) {
      throw new McpError(ErrorCode.MethodNotFound, 'Prompts are disabled');
    }

    try {
      const cursor = request.params?.cursor;
      const result = promptManager.listPrompts(cursor);
      return result;
    } catch (error) {
      criticalLog(`Error listing prompts: ${error}`);
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to list prompts: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  // Register the GetPrompt request handler
  server.setRequestHandler(GetPromptRequestSchema, async request => {
    if (!validatedConfig.enablePrompts || !promptManager) {
      throw new McpError(ErrorCode.MethodNotFound, 'Prompts are disabled');
    }

    try {
      const name = request.params.name;
      const arguments_ = request.params.arguments || {};
      const result = promptManager.getPrompt(name, arguments_);
      return result;
    } catch (error) {
      criticalLog(`Error getting prompt: ${error}`);

      if (error instanceof Error && error.message.includes('not found')) {
        throw new McpError(ErrorCode.InvalidParams, error.message);
      }

      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get prompt: ${error instanceof Error ? error.message : String(error)}`
      );
    }
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
          const transformedResult = transformQueryResult(rawResult, validatedConfig);

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
              // Include query statistics in metadata only if enabled and present
              ...(transformedResult.queryStatistics && {
                queryStatistics: transformedResult.queryStatistics,
              }),
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
