
// Define types for Kusto query and management results
export interface KustoQueryResult {
  tables: KustoTable[];
}

export interface KustoTable {
  name: string;
  columns: KustoColumn[];
  rows: any[][];
}

export interface KustoColumn {
  name: string;
  type: string;
}
/**
 * Safe logging function that won't interfere with MCP protocol
 * 
 * @param message The message to log
 */
export function safeLog(message: string): void {
  process.stderr.write(`${message}\n`);
}