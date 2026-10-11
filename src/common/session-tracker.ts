import type { Attributes } from '@opentelemetry/api';

/**
 * Per-process (per MCP session) behavior signals for `execute-query`, exported
 * only as bounded enums / capped buckets. Nothing here is derived from query
 * text, and no per-query hash is kept or exported. Never throws.
 *
 * MCP requests can overlap, so a query reserves its slot synchronously in
 * `beginQuery` (ordinal, limit, "in flight" state) and reconciles its outcome
 * in `finish`. A later query that starts before an earlier one finished sees
 * `after_in_flight` instead of a stale or duplicated state.
 */

const KNOWN_TOOLS: ReadonlySet<string> = new Set([
  'initialize-connection',
  'show-tables',
  'show-table',
  'show-functions',
  'show-function',
  'execute-query',
  'report-issue',
]);
const SCHEMA_TOOLS: ReadonlySet<string> = new Set([
  'show-tables',
  'show-table',
  'show-functions',
  'show-function',
]);

type Outcome = 'success' | 'error' | 'partial' | 'reduced' | 'in_flight';

export const ORDINAL_BUCKETS = ['1', '2', '3', '4-5', '6-10', '11+'] as const;
export const SCHEMA_CALL_BUCKETS = ['0', '1', '2-3', '4+'] as const;
export const RETRY_CLASSES = [
  'first',
  'after_success',
  'after_error',
  'after_partial',
  'after_reduced',
  'after_in_flight',
] as const;
export const LIMIT_ESCALATIONS = [
  'first',
  'same',
  'raised',
  'lowered',
] as const;
export const PREV_TOOLS = ['none', ...KNOWN_TOOLS, 'other'] as const;

function ordinalBucket(n: number): string {
  if (n <= 3) return String(n);
  if (n <= 5) return '4-5';
  if (n <= 10) return '6-10';
  return '11+';
}

function schemaBucket(n: number): string {
  if (n <= 1) return String(n);
  if (n <= 3) return '2-3';
  return '4+';
}

export interface QueryResult {
  status: string;
  partial?: boolean;
  reduced?: boolean;
  /** False for failures the query text can't fix (connection, auth, read-only block). */
  countsAsQueryFailure?: boolean;
}

export class SessionTracker {
  private lastTool = 'none';
  private queryCount = 0;
  private schemaCalls = 0;
  private last: { outcome: Outcome; limit: number } | undefined;
  private failureStreak = 0;

  /** `execute-query` calls that failed in a row, in completion order. */
  get consecutiveQueryFailures(): number {
    return this.failureStreak;
  }

  /**
   * Reserve a query slot. Returns the attributes to stamp on the span and a
   * `finish` callback to call once the query's outcome is known.
   */
  beginQuery(requestedLimit: number): {
    attributes: Attributes;
    finish: (result: QueryResult) => void;
  } {
    try {
      const prev = this.last;
      const attributes: Attributes = {
        'kustomcp.session.prev_tool': this.lastTool,
        'kustomcp.session.query_ordinal': ordinalBucket(this.queryCount + 1),
        'kustomcp.session.schema_calls_before_query': schemaBucket(
          this.schemaCalls,
        ),
        'kustomcp.query.retry_class': prev ? `after_${prev.outcome}` : 'first',
        'kustomcp.query.limit_escalation': !prev
          ? 'first'
          : requestedLimit > prev.limit
            ? 'raised'
            : requestedLimit < prev.limit
              ? 'lowered'
              : 'same',
      };

      const ticket = ++this.queryCount;
      this.schemaCalls = 0;
      this.lastTool = 'execute-query';
      this.last = { outcome: 'in_flight', limit: requestedLimit };

      return {
        attributes,
        finish: result => {
          try {
            if (result.status !== 'error') this.failureStreak = 0;
            else if (result.countsAsQueryFailure !== false)
              this.failureStreak++;
            // Only the most recent query owns the "previous outcome" state.
            if (this.queryCount !== ticket) return;
            this.last = {
              outcome:
                result.status === 'error'
                  ? 'error'
                  : result.partial
                    ? 'partial'
                    : result.reduced
                      ? 'reduced'
                      : 'success',
              limit: requestedLimit,
            };
          } catch {
            /* telemetry must never fail a call */
          }
        },
      };
    } catch {
      return { attributes: {}, finish: () => undefined };
    }
  }

  /**
   * Record a finished tool call (for the "previous tool" and schema-lookup
   * signals). `execute-query` state is owned by `beginQuery`/`finish`.
   */
  recordCall(tool: string): void {
    try {
      const name = KNOWN_TOOLS.has(tool) ? tool : 'other';
      if (SCHEMA_TOOLS.has(name)) this.schemaCalls++;
      this.lastTool = name;
    } catch {
      /* telemetry must never fail a call */
    }
  }
}
