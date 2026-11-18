/**
 * Agents often send a snake_case or short name for a tool argument (#432):
 * `table` or `table_name` instead of `tableName`. The schemas then reject
 * the call because the required canonical key is missing, which costs the agent a round-trip. Map a known alias to the
 * canonical key before the schema parses the arguments.
 *
 * The advertised JSON schema keeps only the canonical names; aliases are an
 * input tolerance, not part of the contract.
 */

/** Known aliases per tool, keyed by the canonical argument name. */
export const TOOL_ARG_ALIASES: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  'initialize-connection': {
    cluster_url: ['cluster', 'clusterUrl'],
  },
  'show-table': { tableName: ['table', 'table_name'] },
  'show-function': {
    functionName: ['function', 'function_name'],
  },
};

/** True when `toolName` has known aliases (own keys only, not the prototype). */
export function hasArgAliases(toolName: string): boolean {
  return Object.prototype.hasOwnProperty.call(TOOL_ARG_ALIASES, toolName);
}

/**
 * Return a copy of `args` with each absent canonical key filled from its
 * first present (not null or undefined) alias. A canonical key that is present always wins, and the
 * input object is never mutated. Non-object input is returned unchanged so
 * the schema reports it as before.
 *
 * `aliasUsed` is true when at least one alias filled a canonical key. It is
 * a bounded boolean for telemetry; argument values are never exposed.
 */
export function applyArgAliases(
  toolName: string,
  args: unknown,
): { args: unknown; aliasUsed: boolean } {
  const aliases = hasArgAliases(toolName)
    ? TOOL_ARG_ALIASES[toolName]
    : undefined;
  if (
    !aliases ||
    args === null ||
    typeof args !== 'object' ||
    Array.isArray(args)
  ) {
    return { args, aliasUsed: false };
  }
  const input = args as Record<string, unknown>;
  let out: Record<string, unknown> | undefined;
  for (const [canonical, names] of Object.entries(aliases)) {
    // null counts as absent: a null canonical key fails the schema anyway.
    if (input[canonical] != null) continue;
    const alias = names.find(n => input[n] != null);
    if (alias === undefined) continue;
    out ??= { ...input };
    out[canonical] = input[alias];
  }
  return out ? { args: out, aliasUsed: true } : { args, aliasUsed: false };
}
