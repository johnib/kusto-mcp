/**
 * Unit tests for Function Operations
 * Tests the show-functions and show-function tools with mocked Kusto responses
 */

import { jest } from '@jest/globals';
import { KustoQueryError } from '../../../src/common/errors.js';
import { KustoConnection } from '../../../src/operations/kusto/connection.js';
import { showFunction } from '../../../src/operations/kusto/index.js';
import { showFunctions } from '../../../src/operations/kusto/tables.js';
import {
  emptyFunctionListResponse,
  emptyFunctionNameError,
  functionDetailsResponse,
  functionListResponse,
  nonExistentFunctionError,
} from '../fixtures/function-operations-responses.js';
import { createMockError } from '../setup.js';

// Mock the azure-kusto-data client execute method
const mockExecuteQuery = jest.fn<any, any>();

// Mock the KustoConnection
jest.mock('../../../src/operations/kusto/connection.js', () => ({
  KustoConnection: jest.fn().mockImplementation(() => ({
    executeQuery: mockExecuteQuery,
    isInitialized: jest.fn(() => true),
    getDatabase: jest.fn(() => 'ContosoSales'),
  })),
}));

describe('Function Operations Unit Tests', () => {
  let connection: KustoConnection;

  beforeEach(() => {
    jest.clearAllMocks();
    connection = new KustoConnection({
      authMethod: 'azure-cli' as any,
      queryTimeout: 30000,
    });
  });

  describe('show-functions tool', () => {
    test('should list available functions in database', async () => {
      // Mock the Kusto response for function listing
      mockExecuteQuery.mockResolvedValue(functionListResponse);

      const result = await showFunctions(connection);

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(15);

      // Validate function structure
      result.forEach((func: any) => {
        expect(func).toHaveProperty('Name');
        expect(typeof func.Name).toBe('string');
        expect(func.Name.trim()).toBeTruthy();
      });

      // Verify the query was called correctly
      expect(mockExecuteQuery).toHaveBeenCalledWith(
        'ContosoSales',
        '.show functions | project Name, DocString',
      );
    });

    test('should return consistent results for repeated function list calls', async () => {
      // Mock the same response for both calls
      mockExecuteQuery.mockResolvedValue(functionListResponse);

      const firstResult = await showFunctions(connection);
      const secondResult = await showFunctions(connection);

      expect(firstResult).toEqual(secondResult);
      expect(mockExecuteQuery).toHaveBeenCalledTimes(2);
    });

    test('should return proper function metadata', async () => {
      // Mock the function list response
      mockExecuteQuery.mockResolvedValue(functionListResponse);

      const result = await showFunctions(connection);

      // Each function should have at least a Name property
      result.forEach((func: any) => {
        expect(func).toHaveProperty('Name');
        expect(typeof func.Name).toBe('string');

        // Function names should follow KQL naming conventions
        expect(func.Name).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
      });
    });

    test('should handle empty function list', async () => {
      // Mock empty response
      mockExecuteQuery.mockResolvedValue(emptyFunctionListResponse);

      const result = await showFunctions(connection);

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });

    test('should handle query execution errors', async () => {
      // Mock error response
      mockExecuteQuery.mockRejectedValue(new Error('Failed to execute query'));

      await expect(showFunctions(connection)).rejects.toThrow(KustoQueryError);
    });
  });

  describe('show-function tool', () => {
    test('should get function details with parameters and code', async () => {
      // Mock successful function details response
      mockExecuteQuery.mockResolvedValue(functionDetailsResponse);

      const result = await showFunction(connection, 'SalesWithParams');

      // Should have function body
      expect(result.Body).toBeTruthy();
      expect(typeof result.Body).toBe('string');
      expect(result.Body.trim()).toBeTruthy();

      // Function body should contain KQL code
      expect(result.Body.length).toBeGreaterThan(0);

      // Should have proper structure
      expect(result.Name).toBe('SalesWithParams');
      expect(result.Parameters).toBeTruthy();

      // Verify the query was called correctly
      expect(mockExecuteQuery).toHaveBeenCalledWith(
        'ContosoSales',
        '.show function SalesWithParams',
      );
    });

    test('should handle non-existent function requests gracefully', async () => {
      // Mock error response for non-existent function
      mockExecuteQuery.mockRejectedValue(nonExistentFunctionError);

      await expect(
        showFunction(connection, 'NonExistentFunction123'),
      ).rejects.toThrow(KustoQueryError);

      // Verify the query was attempted
      expect(mockExecuteQuery).toHaveBeenCalledWith(
        'ContosoSales',
        '.show function NonExistentFunction123',
      );
    });

    test('should handle empty function name', async () => {
      // Mock error response for empty function name
      mockExecuteQuery.mockRejectedValue(emptyFunctionNameError);

      await expect(showFunction(connection, '')).rejects.toThrow(
        KustoQueryError,
      );

      // Verify the query was attempted with empty name
      expect(mockExecuteQuery).toHaveBeenCalledWith(
        'ContosoSales',
        '.show function ',
      );
    });

    test('should return consistent function details for repeated calls', async () => {
      // Mock the same response for both calls
      mockExecuteQuery.mockResolvedValue(functionDetailsResponse);

      const firstResult = await showFunction(connection, 'SalesWithParams');
      const secondResult = await showFunction(connection, 'SalesWithParams');

      expect(firstResult).toEqual(secondResult);
      expect(mockExecuteQuery).toHaveBeenCalledTimes(2);
    });

    test('should validate function body contains valid KQL', async () => {
      // Mock function details response
      mockExecuteQuery.mockResolvedValue(functionDetailsResponse);

      const result = await showFunction(connection, 'SalesWithParams');

      // Function body should contain typical KQL elements
      const body = result.Body.toLowerCase();

      // Should contain at least some KQL-like content
      expect(body.length).toBeGreaterThan(10);

      // Should contain common KQL patterns
      const commonKqlPatterns = [
        'let',
        'datatable',
        'extend',
        'project',
        'where',
        'summarize',
        'join',
        'union',
        'take',
        'top',
        'sort',
        'order',
        '|',
      ];

      const hasKqlPattern = commonKqlPatterns.some(pattern =>
        body.includes(pattern),
      );

      // If it's a real function, it should have some KQL patterns
      if (body.trim().length > 0) {
        expect(hasKqlPattern).toBe(true);
      }
    });

    test('should handle functions with special characters in names', async () => {
      // Mock error response for function with special characters
      mockExecuteQuery.mockRejectedValue(
        createMockError('Function not found', 'NotFound'),
      );

      await expect(
        showFunction(connection, 'Function-With-Dashes'),
      ).rejects.toThrow();

      // Verify the query was attempted
      expect(mockExecuteQuery).toHaveBeenCalledWith(
        'ContosoSales',
        '.show function Function-With-Dashes',
      );
    });

    test('should handle case-sensitive function names correctly', async () => {
      // First mock successful response for correct case
      mockExecuteQuery.mockResolvedValueOnce(functionDetailsResponse);

      const correctCaseResult = await showFunction(
        connection,
        'SalesWithParams',
      );

      // Should work with correct case
      expect(correctCaseResult.Name).toBe('SalesWithParams');

      // Mock error for wrong case
      mockExecuteQuery.mockRejectedValueOnce(
        createMockError('Function not found', 'NotFound'),
      );

      await expect(
        showFunction(connection, 'saleswithparams'),
      ).rejects.toThrow();
    });

    test('should return complete function details structure', async () => {
      // Mock function details response
      mockExecuteQuery.mockResolvedValue(functionDetailsResponse);

      const result = await showFunction(connection, 'SalesWithParams');

      // Verify all expected fields are present
      expect(result).toHaveProperty('Name');
      expect(result).toHaveProperty('Parameters');
      expect(result).toHaveProperty('Body');
      expect(result).toHaveProperty('Folder');
      expect(result).toHaveProperty('DocString');

      // Verify field values
      expect(result.Name).toBe('SalesWithParams');
      expect(result.Parameters).toBe(
        '(Countries:dynamic, States:dynamic, Cities:dynamic, Colors:dynamic, ClassNames:dynamic)',
      );
      expect(result.DocString).toBe('Query from SalesTable with parameters');
      expect(result.Folder).toBe('');
    });
  });

  describe('Integration scenarios', () => {
    test('should handle function metadata workflow', async () => {
      // First get function list
      mockExecuteQuery.mockResolvedValueOnce(functionListResponse);

      const functions = await showFunctions(connection);
      expect(functions.length).toBeGreaterThan(0);

      // Then get details for the first function
      const functionName = functions[0].Name;
      mockExecuteQuery.mockResolvedValueOnce(functionDetailsResponse);

      const details = await showFunction(connection, functionName);
      expect(details.Name).toBe(functionName);
      expect(details.Body).toBeTruthy();
    });

    test('should validate function naming conventions', async () => {
      // Mock function list response
      mockExecuteQuery.mockResolvedValue(functionListResponse);

      const functions = await showFunctions(connection);

      // All function names should follow proper conventions
      functions.forEach((func: any) => {
        // Function names should be valid identifiers
        expect(func.Name).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
        // Should not be empty
        expect(func.Name.trim()).toBeTruthy();
      });
    });

    test('should handle error scenarios gracefully', async () => {
      // Test various error scenarios
      const errorScenarios = [
        { functionName: '', expectedError: KustoQueryError },
        { functionName: 'NonExistent', expectedError: KustoQueryError },
        { functionName: '123InvalidName', expectedError: KustoQueryError },
      ];

      for (const scenario of errorScenarios) {
        mockExecuteQuery.mockRejectedValueOnce(
          createMockError('Query failed', 'QueryError'),
        );

        await expect(
          showFunction(connection, scenario.functionName),
        ).rejects.toThrow(scenario.expectedError);
      }
    });
  });
});
