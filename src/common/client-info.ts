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

// Only the numeric core leaves: a pre-release or build suffix is free text
// (`1.0.0-alice.corp`), so it is dropped.
const VERSION_CORE = /^v?(\d{1,6}(?:\.\d{1,6}){0,3})(?:[-+].*)?$/;

/** The client name if it is a known product, else 'other'. */
export function clientNameForTelemetry(name: unknown): string | undefined {
  if (typeof name !== 'string' || !name) return undefined;
  return KNOWN_CLIENTS.has(name) ? name : 'other';
}

/** The numeric version (e.g. `1.0.32`), without any suffix; else 'other'. */
export function clientVersionForTelemetry(
  version: unknown,
): string | undefined {
  if (typeof version !== 'string' || !version) return undefined;
  return VERSION_CORE.exec(version)?.[1] ?? 'other';
}
