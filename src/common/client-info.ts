/**
 * MCP clientInfo is free text the client picks. Public hosts send a product
 * name, but custom agents often name themselves after an internal project or
 * team. Only these known product names leave the process; anything else is
 * 'other'. The version keeps only a plain version-number shape.
 */
const KNOWN_CLIENTS: ReadonlySet<string> = new Set([
  'copilot-cli',
  'claude-code',
  'claude-ai',
  'Visual Studio Code',
  'Visual Studio Code - Insiders',
  'VisualStudio',
  'github-copilot-developer',
  'copilot',
  'antigravity-client',
  'codex-mcp-client',
  'cursor-vscode',
  'gemini-cli-mcp-client',
  'opencode',
  'mcporter',
  'windsurf-client',
  'Cline',
  'Roo Code',
  'mcp-inspector',
]);

const VERSION_SHAPE = /^v?\d{1,6}(\.\d{1,6}){0,3}([-+][0-9A-Za-z.-]{1,24})?$/;

/** The client name if it is a known product, else 'other'. */
export function clientNameForTelemetry(name: unknown): string | undefined {
  if (typeof name !== 'string' || !name) return undefined;
  return KNOWN_CLIENTS.has(name) ? name : 'other';
}

/** A version-number string as-is, else 'other'. */
export function clientVersionForTelemetry(
  version: unknown,
): string | undefined {
  if (typeof version !== 'string' || !version) return undefined;
  return VERSION_SHAPE.test(version) ? version : 'other';
}
