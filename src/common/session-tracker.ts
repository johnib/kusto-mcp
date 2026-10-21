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

type Outcome =
  | 'success'
  | 'empty'
  | 'error'
  | 'timeout'
  | 'not_connected'
  | 'cancelled'
  | 'partial'
  | 'reduced'
  | 'in_flight';

export const ORDINAL_BUCKETS = [
  '1',
  '2',
  '3',
  '4-5',
  '6-10',
  '11-20',
  '21-50',
  '51+',
] as const;
export const SCHEMA_CALL_BUCKETS = ['0', '1', '2-3', '4+'] as const;
export const RETRY_CLASSES = [
  'first',
  'after_success',
  'after_empty',
  'after_error',
  'after_timeout',
  'after_not_connected',
  'after_cancelled',
  'after_partial',
  'after_reduced',
  'after_in_flight',
] as const;
/** `last_completed_outcome`: like RETRY_CLASSES, without the `after_` prefix. */
export const LAST_COMPLETED_OUTCOMES = [
  'none',
  'success',
  'empty',
  'error',
  'timeout',
  'not_connected',
  'cancelled',
  'partial',
  'reduced',
] as const;
export const FAILURE_STREAK_BUCKETS = ['0', '1', '2', '3-4', '5+'] as const;
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
  if (n <= 20) return '11-20';
  if (n <= 50) return '21-50';
  return '51+';
}

/** Bucket for `kustomcp.session.failure_streak`. */
export function failureStreakBucket(n: number): string {
  if (n <= 2) return String(n);
  if (n <= 4) return '3-4';
  return '5+';
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
  /** Rows returned; 0 on a success makes the outcome `empty`. */
  rowCount?: number;
  /** `kustomcp.query.failure_category` of a failed query. */
  failureCategory?: string;
  /** False for failures the query text can't fix (connection, auth, read-only block). */
  countsAsQueryFailure?: boolean;
}

function outcomeOf(result: QueryResult): Outcome {
  if (result.status === 'error') {
    if (result.failureCategory === 'timeout') return 'timeout';
    if (result.failureCategory === 'not_connected') return 'not_connected';
    return 'error';
  }
  if (result.status === 'cancelled') return 'cancelled';
  if (result.partial) return 'partial';
  if (result.reduced) return 'reduced';
  if (result.rowCount === 0) return 'empty';
  return 'success';
}

export class SessionTracker {
  private lastTool = 'none';
  private queryCount = 0;
  private schemaCalls = 0;
  private last: { outcome: Outcome; limit: number } | undefined;
  // Outcome of the query that finished last, whichever started last.
  private lastCompleted: Outcome | undefined;
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
        ...this.contextAttributes(),
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
            // A client cancel neither counts toward nor resets the streak.
            if (result.status === 'error') {
              if (result.countsAsQueryFailure !== false) this.failureStreak++;
            } else if (result.status !== 'cancelled') {
              this.failureStreak = 0;
            }
            const outcome = outcomeOf(result);
            this.lastCompleted = outcome;
            // Only the most recent query owns the "previous outcome" state.
            if (this.queryCount !== ticket) return;
            this.last = { outcome, limit: requestedLimit };
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
   * Session attributes for an `execute-query` call whose arguments failed
   * validation. Read-only: an invalid call never reaches Kusto and has no
   * usable limit, so it does not reserve a query ordinal, does not change the
   * retry/limit state seen by the next query, and does not count toward the
   * failure streak. Its `query_ordinal` is therefore the one the next valid
   * query will also get; split the two by `kustomcp.query.outcome`. No
   * `limit_escalation` either, since the limit may be the invalid argument.
   */
  peekQuery(): Attributes {
    try {
      return this.contextAttributes();
    } catch {
      return {};
    }
  }

  private contextAttributes(): Attributes {
    const prev = this.last;
    return {
      'kustomcp.session.prev_tool': this.lastTool,
      'kustomcp.session.query_ordinal': ordinalBucket(this.queryCount + 1),
      'kustomcp.session.schema_calls_before_query': schemaBucket(
        this.schemaCalls,
      ),
      'kustomcp.query.retry_class': prev ? `after_${prev.outcome}` : 'first',
      // The previous query hasn't finished: report the last one that did.
      ...(prev?.outcome === 'in_flight' && {
        'kustomcp.session.last_completed_outcome': this.lastCompleted ?? 'none',
      }),
    };
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
