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
