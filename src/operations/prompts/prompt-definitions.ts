import { PromptDefinition } from '../../types/prompt-interfaces.js';
import {
  loadMarkdownPrompt,
  extractMarkdownTitle,
  extractMarkdownDescription,
  extractMarkdownArguments,
  getAvailableTemplates
} from './markdown-loader.js';

/**
 * Dynamically generate prompt definitions from available .md template files
 */
function generatePromptDefinitions(): PromptDefinition[] {
  const templateNames = getAvailableTemplates();

  return templateNames.map(name => ({
    name,
    title: extractMarkdownTitle(name),
    description: extractMarkdownDescription(name),
    arguments: extractMarkdownArguments(name),
    template: (args: Record<string, string>) => {
      return loadMarkdownPrompt(name, args);
    },
  }));
}

// Cache the prompt definitions to avoid repeated file system operations
let cachedPromptDefinitions: PromptDefinition[] | null = null;

export function getAllPrompts(): PromptDefinition[] {
  if (!cachedPromptDefinitions) {
    cachedPromptDefinitions = generatePromptDefinitions();
  }
  return cachedPromptDefinitions;
}

export function getPromptByName(name: string): PromptDefinition | undefined {
  return getAllPrompts().find(prompt => prompt.name === name);
}

/**
 * Force refresh the prompt definitions cache (useful for testing or when templates are added/removed)
 */
export function refreshPromptDefinitions(): void {
  cachedPromptDefinitions = null;
}