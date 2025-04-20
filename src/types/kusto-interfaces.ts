/**
 * Interface for Kusto connection parameters
 */
export interface KustoConnectionParams {
  /**
   * The URL of the Kusto cluster
   */
  clusterUrl: string;

  /**
   * The database to connect to
   */
  database: string;
}

/**
 * Interface for Kusto table parameters
 */
export interface KustoTableParams {
  /**
   * The database containing the table
   */
  database: string;
}

/**
 * Interface for Kusto table schema parameters
 */
export interface KustoTableSchemaParams {
  /**
   * The name of the table to get the schema for
   */
  tableName: string;
}

/**
 * Interface for Kusto query parameters
 */
export interface KustoQueryParams {
  /**
   * The query to execute
   */
  query: string;
}

/**
 * Interface for a Kusto column
 */
export interface KustoColumnSchema {
  /**
   * The name of the column
   */
  name: string;

  /**
   * The type of the column
   */
  type: string;

  /**
   * Whether the column is nullable
   */
  isNullable?: boolean;

  /**
   * The column's ordinal position
   */
  ordinal?: number;

  /**
   * The column's description
   */
  description?: string;
}

/**
 * Interface for a Kusto table schema
 */
export interface KustoTableSchema {
  /**
   * The name of the table
   */
  tableName: string;

  /**
   * The database containing the table
   */
  databaseName: string;

  /**
   * The columns in the table
   */
  columns: KustoColumnSchema[];

  /**
   * The folder containing the table
   */
  folder?: string;

  /**
   * The table's description
   */
  description?: string;
}

/**
 * Interface for a Kusto query result
 */
export interface KustoQueryResultRow {
  /**
   * The row data as a key-value map
   */
  [key: string]: any;
}

/**
 * Interface for a Kusto query result table
 */
export interface KustoQueryResultTable {
  /**
   * The name of the table
   */
  name: string;

  /**
   * The rows in the table
   */
  rows: KustoQueryResultRow[];
}

/**
 * Interface for a Kusto query result
 */
export interface KustoQueryResult {
  /**
   * The tables in the result
   */
  tables: KustoQueryResultTable[];
}

/**
 * Interface for a Kusto table list item
 */
export interface KustoTableListItem {
  /**
   * The name of the table
   */
  name: string;

  /**
   * The database containing the table
   */
  database: string;

  /**
   * The folder containing the table
   */
  folder?: string;

  /**
   * The table's description
   */
  description?: string;
}

/**
 * Interface for a Kusto function list item
 */
export interface KustoFunctionListItem {
  /**
   * The name of the function
   */
  Name: string;

  /**
   * The function's docstring
   */
  DocString?: string;
}

/**
 * Interface for a Kusto function schema
 */
export interface KustoFunctionSchema {
  /**
   * The name of the function
   */
  Name: string;

  /**
   * The parameters of the function
   */
  Parameters: string;

  /**
   * The body of the function
   */
  Body: string;

  /**
   * The folder containing the function
   */
  Folder?: string;

  /**
   * The function's description
   */
  DocString?: string;
}
