import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { formatKustoMcpError, isKustoMcpError } from "./common/errors.js";
import { safeLog } from "./common/utils.js";
import { executeQuery, KustoConnection, showTable, showTables } from "./operations/kusto/index.js";
import { KustoConfig, validateConfig } from "./types/config.js";

/**
 * Detailed description of the Kusto MCP server for AI assistants
 */
const KUSTO_TOOL_DESCRIPTION = `The assistant's goal is to help users interact with Azure Data Explorer (ADX) effectively.
Start by establishing the connection and maintain a helpful, conversational tone throughout the interaction.

<mcp>
Tools:
- "initialize-connection": Creates connection to an ADX cluster
- "show-tables": list tables in the given database
- "show-table": show the table schema columns
- "execute-query": Runs KQL queries and returns results
</mcp>

<workflow>
1. Connection Setup:
   - Ask for cluster URL and database name
   - Use Azure CLI authentication to connect
   - Store and display available databases

2. Database Exploration:
   - When user mentions data analysis needs, identify target database
   - Use show-tables to fetch tables information, and show-table to fetch table schema
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
  cluster_url: z.string().describe("The URL of the Kusto cluster"),
  database: z.string().describe("The database to connect to")
});

const ShowTablesSchema = z.object({
  database: z.string().describe("The database to list tables from")
});

const ShowTableSchema = z.object({
  tableName: z.string().describe("The name of the table to get the schema for")
});

const ExecuteQuerySchema = z.object({
  query: z.string().describe("The query to execute")
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
      name: "kusto-mcp",
      version: "1.0.0",
      description: KUSTO_TOOL_DESCRIPTION,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );
  
  // Create a Kusto connection
  const connection = new KustoConnection(validatedConfig);
  
  // Register the ListTools request handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "initialize-connection",
          description: "Creates connection to an ADX cluster",
          inputSchema: zodToJsonSchema(InitializeConnectionSchema),
        },
        {
          name: "show-tables",
          description: "List tables in the given database",
          inputSchema: zodToJsonSchema(ShowTablesSchema),
        },
        {
          name: "show-table",
          description: "Show the table schema columns",
          inputSchema: zodToJsonSchema(ShowTableSchema),
        },
        {
          name: "execute-query",
          description: "Runs KQL queries and returns results",
          inputSchema: zodToJsonSchema(ExecuteQuerySchema),
        },
      ],
    };
  });
  
  // Register the CallTool request handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      if (!request.params.arguments) {
        throw new McpError(
          ErrorCode.InvalidParams,
          "Arguments are required"
        );
      }
      
      switch (request.params.name) {
        case "initialize-connection": {
          const args = InitializeConnectionSchema.parse(request.params.arguments);
          const result = await connection.initialize(args.cluster_url, args.database);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }
        
        case "show-tables": {
          const args = ShowTablesSchema.parse(request.params.arguments);
          const result = await showTables(connection, args.database);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }
        
        case "show-table": {
          const args = ShowTableSchema.parse(request.params.arguments);
          const result = await showTable(connection, args.tableName);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }
        
        case "execute-query": {
          const args = ExecuteQuerySchema.parse(request.params.arguments);
          const result = await executeQuery(connection, args.query);
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        }
        
        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${request.params.name}`
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
        errorMessage = `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
      
      return {
        content: [{ type: "text", text: errorMessage }],
        isError: true,
      };
    }
  });
  
  return server;
}

/**
 * Test the connection to a Kusto cluster
 * 
 * @param config The Kusto configuration
 * @returns True if the connection is successful, false otherwise
 */
export async function testConnection(config: KustoConfig): Promise<boolean> {
  try {
    safeLog(`Testing connection to ${config.clusterUrl}...`);
    
    const validatedConfig = validateConfig(config);
    const connection = new KustoConnection(validatedConfig);
    
    await connection.initialize(validatedConfig.clusterUrl, validatedConfig.defaultDatabase || "");
    
    safeLog("Connection successful");
    return true;
  } catch (error) {
    safeLog(`Connection test failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
