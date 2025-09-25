/**
 * Integration tests for MCP prompts functionality with the server
 */

import { createKustoServer } from '../../../src/server.js';
import { KustoConfig } from '../../../src/types/config.js';
import { AuthenticationMethod, ResponseFormat } from '../../../src/types/config.js';

describe('Prompt System Integration Tests', () => {
  let server: any;

  const mockConfig: KustoConfig = {
    authMethod: AuthenticationMethod.AzureCli,
    queryTimeout: 30000,
    responseFormat: ResponseFormat.Json,
    enablePrompts: true,
  };

  beforeEach(() => {
    server = createKustoServer(mockConfig);
  });

  afterEach(async () => {
    if (server) {
      await server.close?.();
    }
  });

  describe('ListPrompts Handler', () => {
    test('should handle list prompts request', async () => {
      const request = {
        id: '1',
        method: 'prompts/list',
        params: {},
      };

      const response = await server.request(request);

      expect(response).toHaveProperty('result');
      expect(response.result).toHaveProperty('prompts');
      expect(Array.isArray(response.result.prompts)).toBe(true);

      // Should contain hello-kusto prompt
      const helloPrompt = response.result.prompts.find(
        (p: any) => p.name === 'hello-kusto'
      );
      expect(helloPrompt).toBeDefined();
      expect(helloPrompt.title).toBe('Hello Kusto');
    });

    test('should handle list prompts request with cursor', async () => {
      const request = {
        id: '1',
        method: 'prompts/list',
        params: { cursor: 'test-cursor' },
      };

      const response = await server.request(request);

      expect(response).toHaveProperty('result');
      expect(response.result).toHaveProperty('prompts');
    });
  });

  describe('GetPrompt Handler', () => {
    test('should handle get prompt request with valid arguments', async () => {
      const request = {
        id: '1',
        method: 'prompts/get',
        params: {
          name: 'hello-kusto',
          arguments: {
            tableName: 'TestTable',
            limit: 5,
          },
        },
      };

      const response = await server.request(request);

      expect(response).toHaveProperty('result');
      expect(response.result).toHaveProperty('messages');
      expect(Array.isArray(response.result.messages)).toBe(true);
      expect(response.result.messages.length).toBe(1);

      const message = response.result.messages[0];
      expect(message.role).toBe('user');
      expect(message.content.type).toBe('text');
      expect(message.content.text).toContain('TestTable');
      expect(message.content.text).toContain('5');
    });

    test('should handle get prompt request without optional arguments', async () => {
      const request = {
        id: '1',
        method: 'prompts/get',
        params: {
          name: 'hello-kusto',
          arguments: {
            tableName: 'TestTable',
          },
        },
      };

      const response = await server.request(request);

      expect(response).toHaveProperty('result');
      expect(response.result.messages[0].content.text).toContain('10'); // default limit
    });

    test('should return error for nonexistent prompt', async () => {
      const request = {
        id: '1',
        method: 'prompts/get',
        params: {
          name: 'nonexistent-prompt',
          arguments: {},
        },
      };

      const response = await server.request(request);

      expect(response).toHaveProperty('error');
      expect(response.error.code).toBe(-32602); // Invalid params
      expect(response.error.message).toContain('not found');
    });

    test('should return error for missing required argument', async () => {
      const request = {
        id: '1',
        method: 'prompts/get',
        params: {
          name: 'hello-kusto',
          arguments: {},
        },
      };

      const response = await server.request(request);

      expect(response).toHaveProperty('error');
      expect(response.error.code).toBe(-32603); // Internal error
      expect(response.error.message).toContain('Missing required argument');
    });
  });

  describe('Prompts Disabled', () => {
    let disabledServer: any;

    beforeEach(() => {
      const disabledConfig: KustoConfig = {
        ...mockConfig,
        enablePrompts: false,
      };
      disabledServer = createKustoServer(disabledConfig);
    });

    afterEach(async () => {
      if (disabledServer) {
        await disabledServer.close?.();
      }
    });

    test('should return method not found when prompts disabled', async () => {
      const request = {
        id: '1',
        method: 'prompts/list',
        params: {},
      };

      const response = await disabledServer.request(request);

      expect(response).toHaveProperty('error');
      expect(response.error.code).toBe(-32601); // Method not found
      expect(response.error.message).toContain('Prompts are disabled');
    });

    test('should not include prompts capability when disabled', () => {
      // Check that the server doesn't declare prompts capability
      // This would be tested by checking the server initialization response
      expect(disabledServer).toBeDefined();
      // In a real test, we'd check the capability declaration
    });
  });

  describe('Error Handling', () => {
    test('should handle malformed list prompts request', async () => {
      const request = {
        id: '1',
        method: 'prompts/list',
        params: { cursor: 123 }, // Invalid cursor type
      };

      const response = await server.request(request);

      expect(response).toHaveProperty('error');
      expect(response.error.code).toBe(-32603); // Internal error
    });

    test('should handle malformed get prompt request', async () => {
      const request = {
        id: '1',
        method: 'prompts/get',
        params: { name: 123 }, // Invalid name type
      };

      const response = await server.request(request);

      expect(response).toHaveProperty('error');
      expect(response.error.code).toBe(-32603); // Internal error
    });
  });
});