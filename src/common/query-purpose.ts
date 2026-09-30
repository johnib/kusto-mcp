/**
 * Optional, LLM-declared intent for an `execute-query` call.
 *
 * The tool schema accepts ANY string (no JSON-schema enum) so telemetry can
 * never interfere with a client's call. Known labels are reported as-is; an
 * unlisted label is reported as `other` plus, only when it looks like a short
 * snake_case token, the label itself so new values can be discovered and added.
 * Anything else (sentences, long or odd strings) is reported as bare `other`.
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

// Short identifier-shaped label: <=32 chars, up to 4 snake_case segments.
const LABEL_SHAPE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+){0,3}$/;
const MAX_LABEL_LENGTH = 32;

export function classifyPurpose(value: unknown): {
  purpose: QueryPurpose | 'unspecified';
  unlisted?: string;
} {
  if (typeof value !== 'string' || value.trim() === '') {
    return { purpose: 'unspecified' };
  }
  const label = value.trim().toLowerCase().replace(/-/g, '_');
  if ((QUERY_PURPOSES as readonly string[]).includes(label)) {
    return { purpose: label as QueryPurpose };
  }
  if (label.length <= MAX_LABEL_LENGTH && LABEL_SHAPE.test(label)) {
    return { purpose: 'other', unlisted: label };
  }
  return { purpose: 'other' };
}
