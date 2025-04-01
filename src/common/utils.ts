import { LRUCache } from 'lru-cache';
import { KustoDataConversionError } from './errors.js';

// Define a type for Kusto query results
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

// Cache for schema information to avoid redundant calls
// Key: database:tableName, Value: table schema
export const schemaCache = new LRUCache<string, KustoTable>({
  max: 100, // Maximum number of items to store
  ttl: 1000 * 60 * 30, // Time to live: 30 minutes
});

/**
 * Convert Kusto query results to a JSON-friendly format
 * 
 * @param result The Kusto query result
 * @returns A JSON-friendly representation of the result
 */
export function kustoResultToJson(result: KustoQueryResult): any {
  try {
    if (!result || !result.tables || !Array.isArray(result.tables)) {
      return { tables: [] };
    }

    return {
      tables: result.tables.map(table => {
        const { name, columns, rows } = table;
        
        // Convert rows to objects with column names as keys
        const formattedRows = rows.map(row => {
          const rowObject: Record<string, any> = {};
          
          columns.forEach((column, index) => {
            rowObject[column.name] = convertKustoValue(row[index], column.type);
          });
          
          return rowObject;
        });
        
        return {
          name,
          rows: formattedRows
        };
      })
    };
  } catch (error) {
    throw new KustoDataConversionError(`Failed to convert Kusto result to JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Convert a Kusto value to a JavaScript value based on its type
 * 
 * @param value The value from Kusto
 * @param type The Kusto data type
 * @returns The converted JavaScript value
 */
export function convertKustoValue(value: any, type: string): any {
  if (value === null || value === undefined) {
    return null;
  }

  try {
    switch (type.toLowerCase()) {
      case 'datetime':
      case 'date':
        // Handle date/time values
        return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
      
      case 'timespan':
        // Handle timespan values (convert to ISO duration format if possible)
        return value.toString();
      
      case 'dynamic':
        // Handle dynamic (JSON) values
        return typeof value === 'string' ? JSON.parse(value) : value;
      
      case 'bool':
      case 'boolean':
        // Handle boolean values
        return Boolean(value);
      
      case 'int':
      case 'long':
      case 'decimal':
      case 'real':
      case 'double':
        // Handle numeric values
        return Number(value);
      
      case 'guid':
      case 'uniqueid':
      case 'string':
        // Handle string values
        return String(value);
      
      default:
        // For unknown types, return as is
        return value;
    }
  } catch (error) {
    console.error(`Error converting value of type ${type}: ${error}`);
    return value; // Return original value on error
  }
}

/**
 * Generate a cache key for schema information
 * 
 * @param database The database name
 * @param tableName The table name
 * @returns A cache key
 */
export function getSchemaKey(database: string, tableName: string): string {
  return `${database}:${tableName}`;
}

/**
 * Safe logging function that won't interfere with MCP protocol
 * 
 * @param message The message to log
 */
export function safeLog(message: string): void {
  process.stderr.write(`${message}\n`);
}
