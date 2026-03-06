import { PromptDefinition } from '../../types/prompt-interfaces.js';
import {
  ListPromptsResult,
  GetPromptResult,
} from '@modelcontextprotocol/sdk/types.js';
import { getAllPrompts, getPromptByName } from './prompt-definitions.js';
import { renderPrompt } from './prompt-renderer.js';

export class PromptManager {
  private prompts: PromptDefinition[];

  constructor() {
    this.prompts = getAllPrompts();
  }

  /**
   * Get list of available prompts with optional pagination
   */
  listPrompts(cursor?: string): ListPromptsResult {
    // For now, we'll return all prompts without pagination
    // In the future, this could be enhanced with actual pagination logic
    const promptList = this.prompts.map(prompt => ({
      name: prompt.name,
      title: prompt.title,
      description: prompt.description,
      arguments: prompt.arguments?.map(arg => ({
        name: arg.name,
        description: arg.description,
        required: arg.required ?? false,
      })),
    }));

    return {
      prompts: promptList,
      nextCursor: undefined, // No pagination for now
    };
  }

  /**
   * Get a specific prompt with rendered content
   */
  getPrompt(name: string, args: Record<string, any> = {}): GetPromptResult {
    const prompt = getPromptByName(name);
    if (!prompt) {
      throw new Error(`Prompt not found: ${name}`);
    }

    const result = renderPrompt(prompt, args);

    // Convert to MCP format
    return {
      description: result.description,
      messages: result.messages.map(msg => ({
        role: msg.role,
        content: {
          type: 'text' as const,
          text: msg.content.text,
        },
      })),
    };
  }

  /**
   * Check if a prompt exists
   */
  hasPrompt(name: string): boolean {
    return getPromptByName(name) !== undefined;
  }

  /**
   * Get all prompt names
   */
  getPromptNames(): string[] {
    return this.prompts.map(p => p.name);
  }
}
