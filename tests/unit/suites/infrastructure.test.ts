/**
 * Infrastructure validation test
 * Ensures unit test setup is working correctly
 */

import { createMockError, createMockKustoResponse } from '../setup.js';

describe('Unit Test Infrastructure', () => {
  beforeEach(() => {
    // Clear all mocks before each test
    jest.clearAllMocks();

    // Clear all timers to prevent open handles
    jest.clearAllTimers();
  });

  afterEach(() => {
    // Clear all mocks after each test
    jest.clearAllMocks();

    // Clear all timers to prevent open handles
    jest.clearAllTimers();

    // Reset modules to clean state
    jest.resetModules();
  });

  test('should load mocked azure-kusto-data', async () => {
    const { Client, KustoConnectionStringBuilder } = await import(
      'azure-kusto-data'
    );

    expect(Client).toBeDefined();
    expect(KustoConnectionStringBuilder).toBeDefined();
    expect(KustoConnectionStringBuilder.withAzLoginIdentity).toBeDefined();
  });

  test('should load mocked @azure/identity', async () => {
    const { AzureCliCredential, DefaultAzureCredential } = await import(
      '@azure/identity'
    );

    expect(AzureCliCredential).toBeDefined();
    expect(DefaultAzureCredential).toBeDefined();
  });

  test('should create mock Kusto client', async () => {
    const { Client } = await import('azure-kusto-data');
    const client = new Client('https://test.kusto.windows.net');

    expect(client).toBeDefined();
    expect(client.executeQuery).toBeDefined();
    expect(jest.isMockFunction(client.executeQuery)).toBe(true);
  });

  test('should create mock Azure credentials', async () => {
    const { AzureCliCredential } = await import('@azure/identity');
    const credential = new AzureCliCredential();

    const token = await credential.getToken(
      'https://help.kusto.windows.net/.default',
    );
    expect(token).toEqual({
      token: 'mock-token',
      expiresOnTimestamp: expect.any(Number),
    });
  });

  test('should create mock Kusto response using helper', () => {
    const response = createMockKustoResponse({
      tableName: 'TestTable',
      columns: [
        { columnName: 'Name', columnType: 'string', dataType: 'System.String' },
        { columnName: 'Count', columnType: 'long', dataType: 'System.Int64' },
      ],
      rows: [['test-name', 42]],
    });

    expect(response).toEqual({
      primaryResults: expect.arrayContaining([
        expect.objectContaining({
          tableName: 'TestTable',
          columns: expect.arrayContaining([
            expect.objectContaining({
              columnName: 'Name',
              columnType: 'string',
            }),
            expect.objectContaining({
              columnName: 'Count',
              columnType: 'long',
            }),
          ]),
          rows: [['test-name', 42]],
        }),
      ]),
      tables: [],
    });
  });

  test('should create mock error using helper', () => {
    const error = createMockError('Test error message', 'TEST_CODE');

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Test error message');
    expect((error as any).code).toBe('TEST_CODE');
  });

  test('should clear mocks between tests', async () => {
    const { Client } = await import('azure-kusto-data');
    const client = new Client('https://test.kusto.windows.net');

    // Mock should be clear (no previous calls)
    expect(client.executeQuery).not.toHaveBeenCalled();

    // Make a call
    await client.executeQuery('testdb', 'test query');
    expect(client.executeQuery).toHaveBeenCalledTimes(1);
  });
});
