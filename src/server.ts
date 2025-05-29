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
import { safeLog } from './common/utils.js';
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

          // Apply limit using N+1 approach for truncation detection
          const limit = args.limit || 20;
          const modifiedQuery = `${args.query} | take ${limit + 1}`;

          const result = await executeQuery(connection, modifiedQuery);

          if (!result.primaryResults || result.primaryResults.length === 0) {
            throw new McpError(
              ErrorCode.InvalidRequest,
              'No primary result found in query response',
            );
          }

          const primaryResult = result.primaryResults[0];
          const rawRows = (primaryResult as any)._rows || [];
          const columns = (primaryResult as any).columns || [];

          // DEBUG: Add detailed logging using safeLog
          safeLog('DEBUG execute-query: STARTED');
          safeLog(`DEBUG execute-query: Query = ${args.query}`);
          safeLog(`DEBUG execute-query: Raw rows = ${JSON.stringify(rawRows)}`);
          safeLog(`DEBUG execute-query: Columns = ${JSON.stringify(columns)}`);
          safeLog(
            `DEBUG execute-query: First row = ${JSON.stringify(rawRows[0])}`,
          );

          // Transform raw array data to objects using column information
          const transformedRows = rawRows.map((row: any[]) => {
            safeLog(
              `DEBUG execute-query: Processing row = ${JSON.stringify(row)}`,
            );
            const obj: any = {};

            if (columns && columns.length > 0) {
              // Use column metadata if available
              safeLog('DEBUG execute-query: Using column metadata');
              columns.forEach((column: any, index: number) => {
                const columnName =
                  column.ColumnName || column.name || `Column${index}`;
                obj[columnName] = row[index];
                safeLog(
                  `DEBUG execute-query: Set ${columnName} = ${row[index]}`,
                );
              });
            } else {
              safeLog('DEBUG execute-query: Using fallback logic');
              // Fallback: Try to infer column names based on query type
              if (args.query.toLowerCase().includes('count')) {
                obj.Count = row[0];
                safeLog(`DEBUG execute-query: Set Count = ${row[0]}`);
              } else if (args.query.toLowerCase().includes('.show tables')) {
                obj.TableName = row[0];
                obj.DatabaseName = row[1];
                obj.Folder = row[2];
                obj.DocString = row[3];
              } else if (args.query.toLowerCase().includes('getschema')) {
                obj.ColumnName = row[0];
                obj.ColumnOrdinal = row[1];
                obj.DataType = row[2];
                obj.ColumnType = row[3];
              } else {
                // Generic fallback - use Column0, Column1, etc.
                row.forEach((value: any, index: number) => {
                  obj[`Column${index}`] = value;
                });
              }
            }

            safeLog(
              `DEBUG execute-query: Transformed object = ${JSON.stringify(
                obj,
              )}`,
            );
            return obj;
          });

          safeLog(
            `DEBUG execute-query: All transformed rows = ${JSON.stringify(
              transformedRows,
            )}`,
          );

          // Detect if results are partial using N+1 approach
          const isPartial = transformedRows.length > limit;
          const returnedRows = isPartial
            ? transformedRows.slice(0, limit)
            : transformedRows;

          safeLog(
            `DEBUG execute-query: Final returned rows = ${JSON.stringify(
              returnedRows,
            )}`,
          );

          // Create enhanced response with metadata
          const enhancedResponse = {
            name: primaryResult.name,
            data: returnedRows,
            metadata: {
              rowCount: returnedRows.length,
              isPartial,
              requestedLimit: limit,
              hasMoreResults: isPartial,
            },
            message: isPartial
              ? 'Results are partial. Consider using aggregations, filters, or more specific conditions to reduce the dataset.'
              : undefined,
          };

          safeLog(
            `DEBUG execute-query: Enhanced response = ${JSON.stringify(
              enhancedResponse,
              null,
              2,
            )}`,
          );

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(enhancedResponse, null, 2),
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
      safeLog(`Error handling tool call: ${error}`);

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

  return server;
}
