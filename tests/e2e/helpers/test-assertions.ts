/**
 * Custom assertions for E2E tests
 */

/**
 * Assert that a response has the expected MCP tool call structure
 */
export function assertToolCallResponse(response: any): void {
  expect(response).toBeDefined();
  expect(response.content).toBeDefined();
  expect(Array.isArray(response.content)).toBe(true);
  expect(response.content.length).toBeGreaterThan(0);
  expect(response.content[0]).toHaveProperty('type', 'text');
  expect(response.content[0]).toHaveProperty('text');
}

/**
 * Assert that a tool call response contains valid JSON data
 */
export function assertValidJsonResponse(response: any): any {
  assertToolCallResponse(response);

  const jsonText = response.content[0].text;
  expect(typeof jsonText).toBe('string');

  let parsedData;
  expect(() => {
    parsedData = JSON.parse(jsonText);
  }).not.toThrow();

  return parsedData;
}

/**
 * Assert that a connection response is successful
 */
export function assertConnectionSuccess(response: any): void {
  const data = assertValidJsonResponse(response);
  expect(data).toHaveProperty('success', true);
  expect(data).toHaveProperty('cluster');
  expect(data).toHaveProperty('database');
  expect(data.cluster).toBe('https://help.kusto.windows.net/');
  expect(data.database).toBe('ContosoSales');
}

/**
 * Assert that a tables list response is valid
 */
export function assertTablesListResponse(response: any): any[] {
  const data = assertValidJsonResponse(response);
  expect(Array.isArray(data)).toBe(true);

  // Should have at least some tables
  expect(data.length).toBeGreaterThan(0);

  // Each table should have expected properties
  data.forEach((table: any) => {
    expect(table).toHaveProperty('TableName');
    expect(typeof table.TableName).toBe('string');
  });

  return data;
}

/**
 * Assert that a table schema response is valid
 */
export function assertTableSchemaResponse(
  response: any,
  expectedTableName: string,
): any {
  const data = assertValidJsonResponse(response);

  // Should be a table schema object, not an array
  expect(typeof data).toBe('object');
  expect(data).toHaveProperty('tableName', expectedTableName);
  expect(data).toHaveProperty('databaseName');
  expect(data).toHaveProperty('columns');
  expect(Array.isArray(data.columns)).toBe(true);

  // Should have at least some columns
  expect(data.columns.length).toBeGreaterThan(0);

  // Each column should have expected properties
  data.columns.forEach((column: any) => {
    expect(column).toHaveProperty('name');
    expect(column).toHaveProperty('type');
    expect(typeof column.name).toBe('string');
    expect(typeof column.type).toBe('string');
    expect(column).toHaveProperty('ordinal');
    expect(typeof column.ordinal).toBe('number');
  });

  return data;
}

/**
 * Assert that a functions list response is valid
 */
export function assertFunctionsListResponse(response: any): any[] {
  const data = assertValidJsonResponse(response);
  expect(Array.isArray(data)).toBe(true);

  // Each function should have expected properties
  data.forEach((func: any) => {
    expect(func).toHaveProperty('Name');
    expect(typeof func.Name).toBe('string');
  });

  return data;
}

/**
 * Assert that a function details response is valid
 */
export function assertFunctionDetailsResponse(
  response: any,
  expectedFunctionName: string,
): any {
  const data = assertValidJsonResponse(response);
  expect(data).toHaveProperty('Name', expectedFunctionName);
  expect(data).toHaveProperty('Body');
  expect(typeof data.Body).toBe('string');

  return data;
}

/**
 * Assert that a query execution response is valid
 */
export function assertQueryExecutionResponse(response: any): any {
  const data = assertValidJsonResponse(response);
  expect(data).toHaveProperty('name');
  expect(data).toHaveProperty('data');
  expect(data).toHaveProperty('metadata');
  expect(Array.isArray(data.data)).toBe(true);

  // Check metadata structure
  expect(data.metadata).toHaveProperty('rowCount');
  expect(data.metadata).toHaveProperty('isPartial');
  expect(data.metadata).toHaveProperty('requestedLimit');
  expect(data.metadata).toHaveProperty('hasMoreResults');

  expect(typeof data.metadata.rowCount).toBe('number');
  expect(typeof data.metadata.isPartial).toBe('boolean');
  expect(typeof data.metadata.requestedLimit).toBe('number');
  expect(typeof data.metadata.hasMoreResults).toBe('boolean');

  return data;
}

/**
 * Assert that a query response has expected number of rows
 */
export function assertQueryRowCount(
  response: any,
  expectedCount?: number,
  maxCount?: number,
): void {
  const data = assertQueryExecutionResponse(response);

  if (expectedCount !== undefined) {
    expect(data.data.length).toBe(expectedCount);
    expect(data.metadata.rowCount).toBe(expectedCount);
  }

  if (maxCount !== undefined) {
    expect(data.data.length).toBeLessThanOrEqual(maxCount);
    expect(data.metadata.rowCount).toBeLessThanOrEqual(maxCount);
  }
}

/**
 * Assert that an error response has the expected structure
 */
export function assertErrorResponse(response: any): void {
  assertToolCallResponse(response);
  expect(response).toHaveProperty('isError', true);

  const errorText = response.content[0].text;
  expect(typeof errorText).toBe('string');
  expect(errorText.length).toBeGreaterThan(0);
}

/**
 * Assert that a response contains a specific error message
 */
export function assertErrorMessage(
  response: any,
  expectedMessage: string,
): void {
  assertErrorResponse(response);
  const errorText = response.content[0].text;
  expect(errorText).toContain(expectedMessage);
}

/**
 * Assert that tools list contains expected tools
 */
export function assertToolsList(toolsResponse: any): void {
  expect(toolsResponse).toHaveProperty('tools');
  expect(Array.isArray(toolsResponse.tools)).toBe(true);

  const expectedTools = [
    'initialize-connection',
    'show-tables',
    'show-table',
    'execute-query',
    'show-functions',
    'show-function',
  ];

  const toolNames = toolsResponse.tools.map((tool: any) => tool.name);

  expectedTools.forEach(expectedTool => {
    expect(toolNames).toContain(expectedTool);
  });

  // Each tool should have required properties
  toolsResponse.tools.forEach((tool: any) => {
    expect(tool).toHaveProperty('name');
    expect(tool).toHaveProperty('description');
    expect(tool).toHaveProperty('inputSchema');
    expect(typeof tool.name).toBe('string');
    expect(typeof tool.description).toBe('string');
    expect(typeof tool.inputSchema).toBe('object');
  });
}
