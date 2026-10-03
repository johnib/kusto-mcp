/**
 * Optional, LLM-declared intent for an `execute-query` call.
 *
 * The tool schema accepts ANY string (no JSON-schema enum) so telemetry can
 * never interfere with a client's call. Known labels are reported as-is. Any
 * other value the caller chose is reported as `other` plus the value itself,
 * exactly as sent, so new categories can be discovered and added to the list.
 * Only a hard length cap guards the exporter against pathological payloads.
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

const MAX_UNLISTED_LENGTH = 512;

export function classifyPurpose(value: unknown): {
  purpose: QueryPurpose | 'unspecified';
  unlisted?: string;
} {
  if (typeof value !== 'string' || value.trim() === '') {
    return { purpose: 'unspecified' };
  }
  const normalized = value.trim().toLowerCase().replace(/-/g, '_');
  if ((QUERY_PURPOSES as readonly string[]).includes(normalized)) {
    return { purpose: normalized as QueryPurpose };
  }
  return { purpose: 'other', unlisted: value.slice(0, MAX_UNLISTED_LENGTH) };
}
