import type { Attributes } from '@opentelemetry/api';

/**
 * Per-process (per MCP session) behavior signals for `execute-query`, exported
 * only as bounded enums / capped buckets. Nothing here is derived from query
 * text, and no per-query hash is kept or exported. Never throws.
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

type Outcome = 'success' | 'error' | 'partial' | 'reduced';

export const ORDINAL_BUCKETS = ['1', '2', '3', '4-5', '6-10', '11+'] as const;
export const SCHEMA_CALL_BUCKETS = ['0', '1', '2-3', '4+'] as const;
export const RETRY_CLASSES = [
  'first',
  'after_success',
  'after_error',
  'after_partial',
  'after_reduced',
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

export class SessionTracker {
  private lastTool = 'none';
  private queryCount = 0;
  private schemaCalls = 0;
  private last: { outcome: Outcome; limit: number } | undefined;

  /** Attributes to stamp on an `execute-query` span, before it runs. */
  beforeQuery(requestedLimit: number): Attributes {
    try {
      const prev = this.last;
      return {
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
    } catch {
      return {};
    }
  }

  /** Record a finished tool call. Call from the handler's `finally`. */
  recordCall(
    tool: string,
    result: {
      status: string;
      limit?: number;
      partial?: boolean;
      reduced?: boolean;
    },
  ): void {
    try {
      const name = KNOWN_TOOLS.has(tool) ? tool : 'other';
      if (name === 'execute-query') {
        this.queryCount++;
        this.schemaCalls = 0;
        this.last = {
          outcome:
            result.status === 'error'
              ? 'error'
              : result.partial
                ? 'partial'
                : result.reduced
                  ? 'reduced'
                  : 'success',
          limit: result.limit ?? this.last?.limit ?? 20,
        };
      } else if (SCHEMA_TOOLS.has(name)) {
        this.schemaCalls++;
      }
      this.lastTool = name;
    } catch {
      /* telemetry must never fail a call */
    }
  }
}
