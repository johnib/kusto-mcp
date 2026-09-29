/**
 * Optional, LLM-declared intent for an `execute-query` call. A FIXED list — no
 * free text ever ships. Anything outside the list is treated as unspecified, so
 * a bad or hallucinated value can never fail a query or leak into telemetry.
 */
export const QUERY_PURPOSES = [
  'schema_discovery',
  'point_lookup',
  'exploration',
  'incident_investigation',
  'service_health',
  'reporting_pipeline',
  'bulk_extract',
  'other',
] as const;

export type QueryPurpose = (typeof QUERY_PURPOSES)[number];

export function coercePurpose(value: unknown): QueryPurpose | 'unspecified' {
  return typeof value === 'string' &&
    (QUERY_PURPOSES as readonly string[]).includes(value)
    ? (value as QueryPurpose)
    : 'unspecified';
}
