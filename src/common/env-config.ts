/**
 * Environment-variable parsing that must be unit-testable without importing
 * `src/index.ts` (which starts the server on import).
 */

const TRUE_VALUES: ReadonlySet<string> = new Set(['true', '1', 'yes', 'on']);

/**
 * Parse KUSTO_ALLOW_WRITE_OPERATIONS. Writes are enabled only by an explicit
 * opt-in (`true`, `1`, `yes`, `on`; case-insensitive, trimmed, with a trailing
 * `# comment` from a Docker env-file ignored). Anything else — unset, empty,
 * `false`, or an unrecognised value — keeps the server read-only, so a typo
 * fails closed.
 */
export function parseAllowWriteOperations(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.split('#')[0].trim().toLowerCase();
  return TRUE_VALUES.has(normalized);
}
