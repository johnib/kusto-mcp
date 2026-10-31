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

// Only major.minor, at most 3 digits each, and only for a known product.
// Any client can claim any name, so the version must be too small to carry
// an identifier: at most 10^6 values. A suffix (`1.0.0-alice.corp`) or an
// unknown client's "version" is free text, so it never leaves.
const VERSION_CORE = /^v?(\d{1,3}(?:\.\d{1,3})?)(?:[.\-+].*)?$/;

/** The client name if it is a known product, else 'other'. */
export function clientNameForTelemetry(name: unknown): string | undefined {
  if (typeof name !== 'string' || !name) return undefined;
  return KNOWN_CLIENTS.has(name) ? name : 'other';
}

/**
 * A known product's major.minor (e.g. `1.105` for 1.105.2), without patch or suffix;
 * 'other' for anything else, including every version of an unknown client.
 */
export function clientVersionForTelemetry(
  version: unknown,
  name: unknown,
): string | undefined {
  if (typeof version !== 'string' || !version) return undefined;
  if (clientNameForTelemetry(name) !== name) return 'other';
  return VERSION_CORE.exec(version)?.[1] ?? 'other';
}
