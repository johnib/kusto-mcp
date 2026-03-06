import {
  PromptDefinition,
  PromptMessage,
  GetPromptResult,
} from '../../types/prompt-interfaces.js';

export function renderPrompt(
  prompt: PromptDefinition,
  args: Record<string, any> = {},
): GetPromptResult {
  // Validate required arguments
  if (prompt.arguments) {
    for (const arg of prompt.arguments) {
      if (arg.required && !(arg.name in args)) {
        throw new Error(`Missing required argument: ${arg.name}`);
      }
    }
  }

  // Render the template
  let content: string;
  if (typeof prompt.template === 'string') {
    content = prompt.template;

    // Simple string substitution for arguments
    if (prompt.arguments) {
      for (const arg of prompt.arguments) {
        const value = args[arg.name];
        if (value !== undefined) {
          content = content.replace(
            new RegExp(`\\{${arg.name}\\}`, 'g'),
            String(value),
          );
        }
      }
    }
  } else {
    content = prompt.template(args);
  }

  const messages: PromptMessage[] = [
    {
      role: 'user',
      content: {
        type: 'text',
        text: content,
      },
    },
  ];

  return {
    description: prompt.description,
    messages,
  };
}
