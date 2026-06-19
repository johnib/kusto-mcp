import { KustoValidationError } from './errors.js';

/**
 * Legal Kusto entity-name characters: letters, digits, underscore, dot, dash,
 * and spaces. Semicolons, colons, pipes, quotes, brackets, parentheses, and
 * comment markers are NOT valid in entity names, so rejecting everything
 * outside this set makes it impossible to break out of the intended command
 * (KQL injection guard). See:
 * https://learn.microsoft.com/kusto/query/schema-entities/entity-names
 */
const SAFE_ENTITY_NAME = /^[A-Za-z0-9_\-. ]+$/;

/**
 * Validate a table/function/entity name supplied by a tool argument and return
 * it trimmed. Throws KustoValidationError if it contains characters that aren't
 * legal in a Kusto identifier.
 */
export function validateEntityName(name: string, kind = 'entity'): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed || trimmed.length > 1024 || !SAFE_ENTITY_NAME.test(trimmed)) {
    throw new KustoValidationError(
      `Invalid ${kind} name: only letters, digits, spaces, '_', '.', and '-' are allowed.`,
    );
  }
  return trimmed;
}

/**
 * Bracket-quote an entity reference for safe interpolation into a query or
 * management command, e.g. `My Table` -> `['My Table']`. The name must already
 * be validated with {@link validateEntityName} so it contains no quotes or
 * brackets that would need escaping.
 */
export function bracketEntityName(name: string): string {
  return `['${name}']`;
}

/**
 * A control/management command is any statement that starts with a dot.
 */
export function isControlCommand(query: string): boolean {
  return query.trimStart().startsWith('.');
}

/**
 * Read-only control commands are the introspective `.show` family. Everything
 * else that starts with a dot (e.g. `.set`, `.append`, `.ingest`, `.drop`,
 * `.create`, `.alter`) can mutate data or schema.
 */
export function isReadOnlyControlCommand(query: string): boolean {
  return /^\s*\.show\b/i.test(query);
}

/**
 * Append an N+1 row limit to a query so the caller can detect whether more
 * data is available than requested. The `take` is added on a NEW LINE so it
 * doesn't merge into a trailing single-line comment (`// ...`), and is skipped
 * for control commands (`.show ...`), which don't accept a piped `| take`.
 * Kusto returns the top rows when the source is sorted, so ordering of sorted
 * queries is preserved.
 */
export function appendRowLimit(query: string, limitPlusOne: number): string {
  if (isControlCommand(query)) {
    return query;
  }
  return `${query}\n| take ${limitPlusOne}`;
}

/**
 * Enforce read-only mode. Plain KQL queries are always reads; `.show` commands
 * are reads. Any other dot-command is a write/management command and is
 * rejected unless writes are explicitly enabled.
 */
export function assertQueryAllowed(query: string, allowWrite: boolean): void {
  if (
    !allowWrite &&
    isControlCommand(query) &&
    !isReadOnlyControlCommand(query)
  ) {
    throw new KustoValidationError(
      'Management/write commands are disabled: this server runs in read-only mode. ' +
        'Only KQL queries and ".show" commands are permitted. ' +
        'Set KUSTO_ALLOW_WRITE_OPERATIONS=true to enable write/management commands.',
    );
  }
}
