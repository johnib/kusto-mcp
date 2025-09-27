import { z } from 'zod';
import { GetPromptResult as SdkGetPromptResult } from '@modelcontextprotocol/sdk/types.js';

export interface PromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface PromptDefinition {
  name: string;
  title?: string;
  description?: string;
  arguments?: PromptArgument[];
  template: string | ((args: Record<string, string>) => string);
}

export interface PromptMessage {
  role: 'user' | 'assistant';
  content: {
    type: 'text';
    text: string;
  };
}

export interface GetPromptResult {
  description?: string;
  messages: PromptMessage[];
}

export const PromptArgumentSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  required: z.boolean().optional().default(false),
});

export const PromptListItemSchema = z.object({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  arguments: z.array(PromptArgumentSchema).optional(),
});

export const PromptsListRequestSchema = z.object({
  cursor: z.string().optional(),
});

export const PromptsListResponseSchema = z.object({
  prompts: z.array(PromptListItemSchema),
  nextCursor: z.string().optional(),
});

export const PromptsGetRequestSchema = z.object({
  name: z.string(),
  arguments: z.record(z.any()).optional(),
});

export const PromptsGetResponseSchema = z.object({
  description: z.string().optional(),
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.object({
      type: z.literal('text'),
      text: z.string(),
    }),
  })),
});

// Use the MCP SDK type for compatibility
export type McpGetPromptResult = SdkGetPromptResult;