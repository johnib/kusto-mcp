/**
 * Unit tests for MCP prompts functionality
 */

import { PromptManager } from '../../../src/operations/prompts/prompt-manager.js';
import { renderPrompt } from '../../../src/operations/prompts/prompt-renderer.js';
import { getAllPrompts, getPromptByName } from '../../../src/operations/prompts/prompt-definitions.js';

describe('Prompt System Unit Tests', () => {
  let promptManager: PromptManager;

  beforeEach(() => {
    promptManager = new PromptManager();
  });

  describe('PromptManager', () => {
    test('should initialize successfully', () => {
      expect(promptManager).toBeDefined();
      expect(promptManager.hasPrompt).toBeDefined();
      expect(promptManager.listPrompts).toBeDefined();
      expect(promptManager.getPrompt).toBeDefined();
    });

    test('should list available prompts', () => {
      const result = promptManager.listPrompts();

      expect(result).toHaveProperty('prompts');
      expect(Array.isArray(result.prompts)).toBe(true);
      expect(result.prompts.length).toBeGreaterThan(0);

      // Should contain the hello-kusto prompt
      const helloPrompt = result.prompts.find(p => p.name === 'hello-kusto');
      expect(helloPrompt).toBeDefined();
      expect(helloPrompt).toMatchObject({
        name: 'hello-kusto',
        title: 'Hello Kusto',
        description: expect.stringContaining('simple test prompt'),
        arguments: expect.arrayContaining([
          expect.objectContaining({
            name: 'tableName',
            required: true,
          }),
          expect.objectContaining({
            name: 'limit',
            required: false,
          }),
        ]),
      });
    });

    test('should check if prompt exists', () => {
      expect(promptManager.hasPrompt('hello-kusto')).toBe(true);
      expect(promptManager.hasPrompt('nonexistent-prompt')).toBe(false);
    });

    test('should get prompt names', () => {
      const names = promptManager.getPromptNames();
      expect(Array.isArray(names)).toBe(true);
      expect(names).toContain('hello-kusto');
    });

    test('should get prompt with valid arguments', () => {
      const result = promptManager.getPrompt('hello-kusto', {
        tableName: 'TestTable',
        limit: 5,
      });

      expect(result).toHaveProperty('messages');
      expect(Array.isArray(result.messages)).toBe(true);
      expect(result.messages.length).toBe(1);

      const message = result.messages[0];
      expect(message.role).toBe('user');
      expect(message.content.type).toBe('text');
      expect(message.content.text).toContain('TestTable');
      expect(message.content.text).toContain('5');
    });

    test('should get prompt with default arguments', () => {
      const result = promptManager.getPrompt('hello-kusto', {
        tableName: 'TestTable',
      });

      const message = result.messages[0];
      expect(message.content.text).toContain('TestTable');
      expect(message.content.text).toContain('10'); // default limit
    });

    test('should throw error for missing required argument', () => {
      expect(() => {
        promptManager.getPrompt('hello-kusto', {});
      }).toThrow('Missing required argument: tableName');
    });

    test('should throw error for nonexistent prompt', () => {
      expect(() => {
        promptManager.getPrompt('nonexistent-prompt', {});
      }).toThrow('Prompt not found: nonexistent-prompt');
    });
  });

  describe('Prompt Renderer', () => {
    test('should render template function prompt', () => {
      const prompt = {
        name: 'test-prompt',
        template: (args: Record<string, any>) => `Hello ${args.name}!`,
      };

      const result = renderPrompt(prompt, { name: 'World' });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content.text).toBe('Hello World!');
    });

    test('should render string template prompt', () => {
      const prompt = {
        name: 'test-prompt',
        template: 'Hello {name}!',
        arguments: [
          { name: 'name', required: true },
        ],
      };

      const result = renderPrompt(prompt, { name: 'World' });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content.text).toBe('Hello World!');
    });

    test('should handle missing optional arguments in string template', () => {
      const prompt = {
        name: 'test-prompt',
        template: 'Hello {name}! Count: {count}',
        arguments: [
          { name: 'name', required: true },
          { name: 'count', required: false },
        ],
      };

      const result = renderPrompt(prompt, { name: 'World' });

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content.text).toBe('Hello World! Count: {count}');
    });

    test('should validate required arguments', () => {
      const prompt = {
        name: 'test-prompt',
        template: 'Hello {name}!',
        arguments: [
          { name: 'name', required: true },
        ],
      };

      expect(() => {
        renderPrompt(prompt, {});
      }).toThrow('Missing required argument: name');
    });
  });

  describe('Prompt Definitions', () => {
    test('should get all prompts', () => {
      const prompts = getAllPrompts();

      expect(Array.isArray(prompts)).toBe(true);
      expect(prompts.length).toBeGreaterThan(0);

      // Should contain hello-kusto prompt
      const helloPrompt = prompts.find(p => p.name === 'hello-kusto');
      expect(helloPrompt).toBeDefined();
    });

    test('should get prompt by name', () => {
      const prompt = getPromptByName('hello-kusto');

      expect(prompt).toBeDefined();
      expect(prompt!.name).toBe('hello-kusto');
      expect(typeof prompt!.template).toBe('function');
    });

    test('should return undefined for nonexistent prompt', () => {
      const prompt = getPromptByName('nonexistent-prompt');
      expect(prompt).toBeUndefined();
    });
  });
});