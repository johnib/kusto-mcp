/**
 * Integration tests for MCP prompts functionality with the server
 */

import { MCPTestClient } from '../helpers/mcp-test-client.js';

describe('Prompt System Integration Tests', () => {
  let client: MCPTestClient;

  beforeEach(async () => {
    client = new MCPTestClient();
    await client.startServer();
  });

  afterEach(async () => {
    if (client) {
      await client.stopServer();
    }
  });

  describe('ListPrompts Handler', () => {
    test('should handle list prompts request', async () => {
      const response = await client.listPrompts();

      expect(response).toHaveProperty('prompts');
      expect(Array.isArray(response.prompts)).toBe(true);

      // Should contain analyze-query-perf prompt
      const perfPrompt = response.prompts.find(
        (p: any) => p.name === 'analyze-query-perf'
      );
      expect(perfPrompt).toBeDefined();
      expect(perfPrompt.description).toContain('Analyze');
    });

    test('should handle list prompts request with cursor', async () => {
      const response = await client.listPrompts('test-cursor');

      expect(response).toHaveProperty('prompts');
      expect(Array.isArray(response.prompts)).toBe(true);
    });
  });

  describe('GetPrompt Handler', () => {
    test('should handle get prompt request with valid arguments', async () => {
      const response = await client.getPrompt('analyze-query-perf', {
        query: 'TestTable | count',
      });

      expect(response).toHaveProperty('messages');
      expect(Array.isArray(response.messages)).toBe(true);
      expect(response.messages.length).toBe(1);

      const message = response.messages[0];
      expect(message.role).toBe('user');
      expect(message.content.type).toBe('text');
      expect(message.content.text).toContain('TestTable | count');
      expect(message.content.text.toLowerCase()).toContain('performance');
    });

    test('should handle get prompt request with required arguments', async () => {
      const response = await client.getPrompt('analyze-query-perf', {
        query: 'TestTable | count',
      });

      expect(response).toHaveProperty('messages');
      expect(response.messages[0].content.text.toLowerCase()).toContain('performance');
    });

    test('should return error for nonexistent prompt', async () => {
      await expect(
        client.getPrompt('nonexistent-prompt', {})
      ).rejects.toThrow();
    });

    test('should return error for missing required argument', async () => {
      await expect(
        client.getPrompt('analyze-query-perf', {})
      ).rejects.toThrow();
    });
  });

  describe('Prompt Content Validation', () => {
    test('should return prompt with proper structure', async () => {
      const listResponse = await client.listPrompts();

      // Each prompt should have required fields
      listResponse.prompts.forEach((prompt: any) => {
        expect(prompt).toHaveProperty('name');
        expect(typeof prompt.name).toBe('string');
        expect(prompt.name.length).toBeGreaterThan(0);
      });
    });

    test('should return analyze-query-perf prompt with correct arguments', async () => {
      const listResponse = await client.listPrompts();

      const perfPrompt = listResponse.prompts.find(
        (p: any) => p.name === 'analyze-query-perf'
      );

      expect(perfPrompt).toBeDefined();
      expect(perfPrompt).toHaveProperty('arguments');
      expect(Array.isArray(perfPrompt.arguments)).toBe(true);

      // Should have a 'query' argument
      const queryArg = perfPrompt.arguments.find((a: any) => a.name === 'query');
      expect(queryArg).toBeDefined();
      expect(queryArg.required).toBe(true);
    });
  });
});
