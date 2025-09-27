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
  console.log('[prompt-definitions] generatePromptDefinitions() called');
  const templateNames = getAvailableTemplates();
  console.log('[prompt-definitions] - templateNames returned:', templateNames);

  const definitions = templateNames.map(name => ({
    name,
    title: extractMarkdownTitle(name),
    description: extractMarkdownDescription(name),
    arguments: extractMarkdownArguments(name),
    template: (args: Record<string, string>) => {
      return loadMarkdownPrompt(name, args);
    },
  }));

  console.log('[prompt-definitions] - generated definitions:', definitions.map(d => ({ name: d.name, title: d.title })));
  return definitions;
}

// Cache the prompt definitions to avoid repeated file system operations
let cachedPromptDefinitions: PromptDefinition[] | null = null;

export function getAllPrompts(): PromptDefinition[] {
  console.log('[prompt-definitions] getAllPrompts() called');
  console.log('[prompt-definitions] - cachedPromptDefinitions is null:', cachedPromptDefinitions === null);

  if (!cachedPromptDefinitions) {
    console.log('[prompt-definitions] - generating new prompt definitions...');
    cachedPromptDefinitions = generatePromptDefinitions();
    console.log('[prompt-definitions] - cached definitions count:', cachedPromptDefinitions.length);
  }

  console.log('[prompt-definitions] - returning', cachedPromptDefinitions.length, 'prompts');
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