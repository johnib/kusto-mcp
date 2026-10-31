/**
 * MCP clientInfo is free text the client picks. Public hosts send a product
 * name, but custom agents often name themselves after an internal project or
 * team. Only these known product names leave the process; anything else is
 * 'other'. The client version is never exported: any client can claim a
 * known name, so no value of it is safe.
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

/** The client name if it is a known product, else 'other'. */
export function clientNameForTelemetry(name: unknown): string | undefined {
  if (typeof name !== 'string' || !name) return undefined;
  return KNOWN_CLIENTS.has(name) ? name : 'other';
}
