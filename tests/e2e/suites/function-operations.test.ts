import { E2E_TEST_CONFIG } from '../config.js';
import { MCPTestClient } from '../helpers/mcp-test-client.js';
import {
  assertConnectionSuccess,
  assertErrorMessage,
  assertFunctionDetailsResponse,
  assertFunctionsListResponse,
} from '../helpers/test-assertions.js';

describe('Function Operations', () => {
  let client: MCPTestClient;

  beforeEach(async () => {
    client = new MCPTestClient();
    await client.startServer();

    // Initialize connection for all tests
    const initResponse = await client.callTool('initialize-connection', {
      cluster_url: E2E_TEST_CONFIG.cluster,
      database: E2E_TEST_CONFIG.database,
    });
    assertConnectionSuccess(initResponse);
  });

  afterEach(async () => {
    if (client) {
      await client.stopServer();
    }
  });

  test('should list available functions in database', async () => {
    const response = await client.callTool('show-functions', {});

    const functions = assertFunctionsListResponse(response);

    // Should return an array (may be empty if no functions)
    expect(Array.isArray(functions)).toBe(true);

    // If functions exist, validate their structure
    functions.forEach(func => {
      expect(func).toHaveProperty('Name');
      expect(typeof func.Name).toBe('string');
      expect(func.Name.trim()).toBeTruthy();
    });
  });

  test('should get function details with parameters and code', async () => {
    // First get the list of functions
    const functionsResponse = await client.callTool('show-functions', {});
    const functions = assertFunctionsListResponse(functionsResponse);

    if (functions.length > 0) {
      const functionName = functions[0].Name;

      // Get details for the first function
      const detailsResponse = await client.callTool('show-function', {
        functionName: functionName,
      });

      const details = assertFunctionDetailsResponse(
        detailsResponse,
        functionName,
      );

      // Should have function body
      expect(details.Body).toBeTruthy();
      expect(typeof details.Body).toBe('string');
      expect(details.Body.trim()).toBeTruthy();

      // Function body should contain KQL code
      expect(details.Body.length).toBeGreaterThan(0);
    } else {
      // If no functions exist, that's okay for this test database
      console.log('No functions found in ContosoSales database');
    }
  });

  test('should handle non-existent function requests gracefully', async () => {
    const response = await client.callTool('show-function', {
      functionName: 'NonExistentFunction123',
    });

    assertErrorMessage(response, 'Error');
  });

  test('should handle empty function name', async () => {
    const response = await client.callTool('show-function', {
      functionName: '',
    });

    assertErrorMessage(response, 'Error');
  });

  test('should return proper function metadata', async () => {
    const response = await client.callTool('show-functions', {});
    const functions = assertFunctionsListResponse(response);

    if (functions.length > 0) {
      // Each function should have at least a Name property
      functions.forEach(func => {
        expect(func).toHaveProperty('Name');
        expect(typeof func.Name).toBe('string');

        // Function names should follow KQL naming conventions
        expect(func.Name).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]*$/);
      });

      // Test getting details for each function
      for (const func of functions.slice(0, 3)) {
        // Test first 3 functions to avoid timeout
        const detailsResponse = await client.callTool('show-function', {
          functionName: func.Name,
        });

        const details = assertFunctionDetailsResponse(
          detailsResponse,
          func.Name,
        );

        // Should have proper structure
        expect(details.Name).toBe(func.Name);
        expect(details.Body).toBeTruthy();
      }
    }
  });

  test('should handle functions with special characters in names', async () => {
    // Test with function name that might have special characters
    const response = await client.callTool('show-function', {
      functionName: 'Function-With-Dashes',
    });

    // Should handle gracefully (either success or proper error)
    if (response.isError) {
      assertErrorMessage(response, 'Error');
    } else {
      assertFunctionDetailsResponse(response, 'Function-With-Dashes');
    }
  });

  test('should return consistent results for repeated function list calls', async () => {
    const firstResponse = await client.callTool('show-functions', {});
    const secondResponse = await client.callTool('show-functions', {});

    const firstFunctions = assertFunctionsListResponse(firstResponse);
    const secondFunctions = assertFunctionsListResponse(secondResponse);

    // Results should be identical
    expect(firstFunctions).toEqual(secondFunctions);
  });

  test('should return consistent function details for repeated calls', async () => {
    const functionsResponse = await client.callTool('show-functions', {});
    const functions = assertFunctionsListResponse(functionsResponse);

    if (functions.length > 0) {
      const functionName = functions[0].Name;

      // Get details multiple times
      const firstDetails = await client.callTool('show-function', {
        functionName: functionName,
      });

      const secondDetails = await client.callTool('show-function', {
        functionName: functionName,
      });

      const firstResult = assertFunctionDetailsResponse(
        firstDetails,
        functionName,
      );
      const secondResult = assertFunctionDetailsResponse(
        secondDetails,
        functionName,
      );

      // Results should be identical
      expect(firstResult).toEqual(secondResult);
    }
  });

  test('should validate function body contains valid KQL', async () => {
    const functionsResponse = await client.callTool('show-functions', {});
    const functions = assertFunctionsListResponse(functionsResponse);

    if (functions.length > 0) {
      const functionName = functions[0].Name;
      const detailsResponse = await client.callTool('show-function', {
        functionName: functionName,
      });

      const details = assertFunctionDetailsResponse(
        detailsResponse,
        functionName,
      );

      // Function body should contain typical KQL elements
      const body = details.Body.toLowerCase();

      // Should contain at least some KQL-like content
      expect(body.length).toBeGreaterThan(10);

      // Might contain common KQL keywords (this is flexible as it depends on actual functions)
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
    }
  });

  test('should handle case-sensitive function names correctly', async () => {
    const functionsResponse = await client.callTool('show-functions', {});
    const functions = assertFunctionsListResponse(functionsResponse);

    if (functions.length > 0) {
      const originalName = functions[0].Name;

      // Test with original case
      const correctCaseResponse = await client.callTool('show-function', {
        functionName: originalName,
      });

      // Should work with correct case
      if (!correctCaseResponse.isError) {
        assertFunctionDetailsResponse(correctCaseResponse, originalName);
      }

      // Test with different case (if the original has mixed case)
      if (originalName !== originalName.toLowerCase()) {
        const wrongCaseResponse = await client.callTool('show-function', {
          functionName: originalName.toLowerCase(),
        });

        // This might fail due to case sensitivity
        if (wrongCaseResponse.isError) {
          assertErrorMessage(wrongCaseResponse, 'Error');
        }
      }
    }
  });
});
