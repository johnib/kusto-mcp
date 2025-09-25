import { PromptDefinition } from '../../types/prompt-interfaces.js';
import { loadMarkdownPrompt, extractMarkdownTitle, extractMarkdownDescription, extractMarkdownArguments } from './markdown-loader.js';

export const PROMPT_DEFINITIONS: PromptDefinition[] = [
  {
    name: 'hello-kusto',
    title: extractMarkdownTitle('hello-kusto'),
    description: extractMarkdownDescription('hello-kusto'),
    arguments: extractMarkdownArguments('hello-kusto'),
    template: (args: Record<string, string>) => {
      // Provide default value for limit if not specified
      const templateArgs = {
        ...args,
        limit: args.limit || '10'
      };
      return loadMarkdownPrompt('hello-kusto', templateArgs);
    },
  },
  {
    name: 'analyze-query-perf',
    title: extractMarkdownTitle('analyze-query-perf'),
    description: extractMarkdownDescription('analyze-query-perf'),
    arguments: extractMarkdownArguments('analyze-query-perf'),
    template: (args: Record<string, string>) => {
      return loadMarkdownPrompt('analyze-query-perf', args);
    },
  },
];

export function getAllPrompts(): PromptDefinition[] {
  return PROMPT_DEFINITIONS;
}

export function getPromptByName(name: string): PromptDefinition | undefined {
  return PROMPT_DEFINITIONS.find(prompt => prompt.name === name);
}