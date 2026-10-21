import type { Attributes } from '@opentelemetry/api';

/**
 * Privacy-safe "what does this query do" telemetry.
 *
 * Derives closed-vocabulary features from a query WITHOUT ever exporting any
 * part of its text. Rules that keep it inside the README contract:
 *   - Query text is only ever *matched* against frozen allowlists. No token, no
 *     substring and no capture group is ever copied into an attribute value.
 *   - Comments, string literals and bracketed identifiers are skipped before
 *     matching, so user identifiers can't reach an allowlist by accident.
 *   - Operators only count in operator position (start of statement / after `|`),
 *     so a column or table named `join` is not counted as a join.
 *   - Anything not on an allowlist collapses to `other`; counts are capped.
 *   - Never throws (runs on the tool path); any failure yields `unparsed`.
 */

const PREFIX = 'kustomcp.query.';
const MAX_SCAN_CHARS = 64 * 1024;
const COUNT_CAP = 10;
const PIPE_CAP = 20;

// Operator name (as written, lowercased) -> reported family. Frozen vocabulary.
const OPERATOR_FAMILY: ReadonlyMap<string, string> = new Map([
  ['where', 'where'],
  ['project', 'project'],
  ['project-away', 'project'],
  ['project-keep', 'project'],
  ['project-rename', 'project'],
  ['project-reorder', 'project'],
  ['extend', 'extend'],
  ['summarize', 'summarize'],
  ['join', 'join'],
  ['union', 'union'],
  ['lookup', 'lookup'],
  ['take', 'take'],
  ['limit', 'take'],
  ['top', 'top'],
  ['top-nested', 'top'],
  ['top-hitters', 'top'],
  ['sort', 'sort'],
  ['order', 'sort'],
  ['distinct', 'distinct'],
  ['count', 'count'],
  ['render', 'render'],
  ['parse', 'parse'],
  ['parse-where', 'parse'],
  ['mv-expand', 'mv_expand'],
  ['mv-apply', 'mv_expand'],
  ['make-series', 'make_series'],
  ['evaluate', 'evaluate'],
  ['search', 'search'],
  ['find', 'find'],
  ['getschema', 'getschema'],
  ['externaldata', 'externaldata'],
  ['sample', 'sample'],
  ['sample-distinct', 'sample'],
  ['invoke', 'invoke'],
  ['scan', 'scan'],
  ['fork', 'fork'],
  ['partition', 'partition'],
  ['facet', 'facet'],
  ['serialize', 'serialize'],
]);

// Operators that may start a statement without a leading `|`.
const STATEMENT_START_OPERATORS: ReadonlySet<string> = new Set([
  'union',
  'search',
  'find',
  'externaldata',
  'evaluate',
]);

// After `(`, only `union` is treated as an operator: other words are too often
// plain column names inside call arguments.
const PAREN_START_OPERATORS: ReadonlySet<string> = new Set(['union']);

export const QUERY_OPERATOR_VOCAB: readonly string[] = [
  ...new Set(OPERATOR_FAMILY.values()),
  'other',
];

const SHOW_COMMANDS: ReadonlySet<string> = new Set([
  'tables',
  'table',
  'functions',
  'function',
  'databases',
  'database',
  'schema',
  'queries',
  'operations',
  'journal',
  'cluster',
  'version',
  'capacity',
  'commands',
]);

export const QUERY_STMT_KIND_VOCAB = [
  'query',
  'control_show',
  'control_create',
  'control_alter',
  'control_drop',
  'control_ingest',
  'control_other',
  'unparsed',
] as const;
export const QUERY_CONTROL_CMD_VOCAB = [...SHOW_COMMANDS, 'other', 'none'];
export const QUERY_TIME_WINDOW_VOCAB = [
  'none',
  '<=1h',
  '<=1d',
  '<=7d',
  '<=30d',
  '>30d',
  'absolute',
  'unknown',
] as const;
// Span between the earliest and latest datetime() literal, in the ago() buckets.
export const QUERY_ABSOLUTE_RANGE_VOCAB = [
  '<=1h',
  '<=1d',
  '<=7d',
  '<=30d',
  '>30d',
  'unknown',
] as const;
export const QUERY_COMPLEXITY_VOCAB = [
  'trivial',
  'simple',
  'moderate',
  'complex',
] as const;

const UNIT_SECONDS: Readonly<Record<string, number>> = {
  ms: 0.001,
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
};

// `datetime(2024-01-01)`, `datetime(2024-01-01 10:00:00.5)`,
// `datetime("2024-01-01T10:00Z")`, matched from just after the word. The parts
// are only turned into a number of seconds; nothing is copied out. A literal
// followed by `+`/`-` (`datetime(x) + 2d`) is not its own bound: no match.
const DATETIME_LITERAL =
  /\s*\(\s*(["']?)(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d{1,7}))?)?)?Z?\1\s*\)(?!\s*[-+])/iy;
type Instant = readonly [number, number];
const DATETIME_NULL = /\s*\(\s*null\s*\)/iy;

/**
 * [whole epoch seconds, fraction] of the datetime literal starting at `at`
 * (kept apart so 100ns survives subtraction), null for
 * `datetime(null)`, or undefined.
 */
function datetimeLiteral(q: string, at: number): Instant | null | undefined {
  DATETIME_NULL.lastIndex = at;
  if (DATETIME_NULL.test(q)) return null;
  DATETIME_LITERAL.lastIndex = at;
  const m = DATETIME_LITERAL.exec(q);
  if (!m) return undefined;
  const [y, mo, d, h, mi, s] = m.slice(2, 8).map(x => Number(x ?? 0));
  // Kusto datetimes start at year 0001.
  if (y < 1 || h > 23 || mi > 59 || s > 59) return undefined;
  // setUTCFullYear keeps years 0-99 as is; a day the month doesn't have
  // (2024-02-30) rolls over and is rejected below.
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
    return undefined;
  }
  const frac = m[8] ? Number(`0.${m[8]}`) : 0;
  return [date.getTime() / 1000 + h * 3600 + mi * 60 + s, frac];
}

type Tok =
  | { t: 'word'; v: string; ts?: Instant | null }
  | { t: 'num'; v: string }
  | {
      t:
        | 'pipe'
        | 'semi'
        | 'lparen'
        | 'rparen'
        | 'lbrace'
        | 'dot'
        | 'eq'
        | 'other';
      // On `>`/`>=` (lower bound follows) and `<`/`<=` (upper bound follows).
      bound?: 'lo' | 'hi';
    };

// Pairs the two ends of `between (a .. b)`; never equal to a column word.
const BETWEEN = '(between)';

const boundTok = (c: string): Tok =>
  c === '>'
    ? { t: 'other', bound: 'lo' }
    : c === '<'
      ? { t: 'other', bound: 'hi' }
      : { t: 'other' };

const isWordStart = (c: string) => /[A-Za-z_]/.test(c);
const isWordChar = (c: string) => /[A-Za-z0-9_]/.test(c);
const isDigit = (c: string) => c >= '0' && c <= '9';

/**
 * Single linear pass. Returns undefined when the text can't be tokenized
 * safely (unterminated string / bracket). Strings, comments and bracketed
 * identifiers become anonymous `other` tokens: their content is discarded.
 */
function lex(q: string): Tok[] | undefined {
  const toks: Tok[] = [];
  const n = q.length;
  let i = 0;
  while (i < n) {
    const c = q[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
    } else if (c === '/' && q[i + 1] === '/') {
      while (i < n && q[i] !== '\n') i++;
    } else if (q.startsWith('```', i) || q.startsWith('~~~', i)) {
      const end = q.indexOf(q.slice(i, i + 3), i + 3);
      if (end < 0) return undefined;
      i = end + 3;
      toks.push({ t: 'other' });
    } else if (c === '@' && (q[i + 1] === '"' || q[i + 1] === "'")) {
      // Verbatim string: no escapes, a doubled quote is a literal quote.
      const quote = q[i + 1];
      i += 2;
      for (;;) {
        if (i >= n) return undefined;
        if (q[i] === quote) {
          if (q[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      toks.push({ t: 'other' });
    } else if (c === '"' || c === "'") {
      i++;
      for (;;) {
        if (i >= n) return undefined;
        if (q[i] === '\\') {
          i += 2;
          continue;
        }
        if (q[i] === c) {
          i++;
          break;
        }
        i++;
      }
      toks.push({ t: 'other' });
    } else if (c === '[') {
      // ['my table'], ["col"], [0] or an array literal: discard the contents.
      i++;
      while (i < n && q[i] !== ']') {
        if (q[i] === "'" || q[i] === '"') {
          const quote = q[i];
          i++;
          while (i < n && q[i] !== quote) {
            if (q[i] === '\\') i++;
            i++;
          }
        }
        i++;
      }
      if (i >= n) return undefined;
      i++;
      toks.push({ t: 'other' });
    } else if (isWordStart(c)) {
      const start = i;
      i++;
      while (i < n) {
        if (isWordChar(q[i])) i++;
        else if (q[i] === '-' && i + 1 < n && isWordStart(q[i + 1])) i++;
        else break;
      }
      const v = q.slice(start, i).toLowerCase();
      toks.push(
        v === 'datetime'
          ? { t: 'word', v, ts: datetimeLiteral(q, i) }
          : { t: 'word', v },
      );
    } else if (isDigit(c)) {
      const start = i;
      i++;
      while (i < n && (isDigit(q[i]) || q[i] === '.')) i++;
      toks.push({ t: 'num', v: q.slice(start, i) });
    } else {
      if (c === '|') toks.push({ t: 'pipe' });
      else if (c === ';') toks.push({ t: 'semi' });
      else if (c === '(') toks.push({ t: 'lparen' });
      else if (c === '{') toks.push({ t: 'lbrace' });
      else if (c === ')') toks.push({ t: 'rparen' });
      else if (c === '.') toks.push({ t: 'dot' });
      else if (c === '=' && !'=~>'.includes(q[i + 1] ?? ' ')) {
        toks.push({ t: 'eq' });
      } else if ('=!<>'.includes(c) && (q[i + 1] === '=' || q[i + 1] === '~')) {
        // ==, =~, =>, !=, !~, <=, >= are comparison operators, not assignment.
        toks.push(boundTok(c));
        i++;
      } else toks.push(boundTok(c));
      i++;
    }
  }
  return toks;
}

function controlKind(word: string): (typeof QUERY_STMT_KIND_VOCAB)[number] {
  if (word === 'show') return 'control_show';
  if (word.startsWith('create')) return 'control_create';
  if (word.startsWith('alter')) return 'control_alter';
  if (word.startsWith('drop')) return 'control_drop';
  if (
    word === 'ingest' ||
    word === 'append' ||
    word === 'replace' ||
    word.startsWith('set')
  ) {
    return 'control_ingest';
  }
  return 'control_other';
}

function windowBucket(seconds: number): string {
  if (seconds <= 3600) return '<=1h';
  if (seconds <= 86400) return '<=1d';
  if (seconds <= 7 * 86400) return '<=7d';
  if (seconds <= 30 * 86400) return '<=30d';
  return '>30d';
}

const cap = (n: number, max: number) => Math.min(n, max);

/**
 * Classify a query's shape into bounded, non-identifying attributes.
 * Returns `{ 'kustomcp.query.stmt_kind': 'unparsed' }` if it can't be analysed.
 */
export function classifyQueryShape(query: string): Attributes {
  const unparsed: Attributes = { [`${PREFIX}stmt_kind`]: 'unparsed' };
  try {
    if (typeof query !== 'string' || query.length > MAX_SCAN_CHARS) {
      return unparsed;
    }
    const toks = lex(query);
    if (!toks) return unparsed;

    const first = toks[0];
    const second = toks[1];
    if (first?.t === 'dot' && second?.t === 'word') {
      const kind = controlKind(second.v);
      const third = toks[2];
      const cmd =
        kind === 'control_show'
          ? third?.t === 'word' && SHOW_COMMANDS.has(third.v)
            ? third.v
            : 'other'
          : 'none';
      return {
        [`${PREFIX}stmt_kind`]: kind,
        [`${PREFIX}control_cmd`]: cmd,
      };
    }

    const operators = new Set<string>();
    let pipes = 0;
    let joins = 0;
    let unions = 0;
    let lets = 0;
    let maxAgoSeconds = -1;
    let sawUnparsableAgo = false;
    let sawDatetime = false;
    let sawUnparsableDatetime = false;
    // Parsed datetime() literals: value, token index, and which bound of a
    // range the preceding tokens make it (`> x`, `between (x`; `< x`, `.. x`).
    const datetimes: {
      ts: Instant;
      k: number;
      bound?: 'lo' | 'hi';
      col?: string;
    }[] = [];
    let atStatementStart = true;
    let expectOperator = false;
    // Words allowed to count as an operator at the very next token (after `(`
    // or after the `=` of a `let` binding).
    let pendingStart: ReadonlySet<string> | null = null;
    let inLet = false;
    let letEqSeen = false;

    const countOperator = (word: string) => {
      const family = OPERATOR_FAMILY.get(word) ?? 'other';
      operators.add(family);
      if (family === 'join') joins++;
      if (family === 'union') unions++;
    };

    for (let k = 0; k < toks.length; k++) {
      const tk = toks[k];
      if (tk.t === 'semi') {
        atStatementStart = true;
        expectOperator = false;
        pendingStart = null;
        inLet = false;
        letEqSeen = false;
        continue;
      }
      if (tk.t === 'pipe') {
        pipes++;
        expectOperator = true;
        pendingStart = null;
        atStatementStart = false;
        continue;
      }
      if (tk.t === 'lparen') {
        pendingStart = PAREN_START_OPERATORS;
        expectOperator = false;
        atStatementStart = false;
        continue;
      }
      if (tk.t === 'lbrace') {
        // Body of a `let` function/view: its first word may be a tabular
        // operator. Outside a `let`, braces are scalar/dynamic content.
        pendingStart = inLet ? STATEMENT_START_OPERATORS : null;
        expectOperator = false;
        atStatementStart = false;
        continue;
      }
      if (tk.t === 'eq' && inLet && !letEqSeen) {
        letEqSeen = true;
        pendingStart = STATEMENT_START_OPERATORS;
        expectOperator = false;
        continue;
      }
      if (tk.t === 'word') {
        if (expectOperator) {
          countOperator(tk.v);
        } else if (atStatementStart) {
          if (tk.v === 'let') {
            lets++;
            inLet = true;
          } else if (STATEMENT_START_OPERATORS.has(tk.v)) {
            // Only operators that can legally begin a statement; any other
            // word here is a table name (e.g. a table called `join`).
            countOperator(tk.v);
          }
        } else if (pendingStart?.has(tk.v)) {
          countOperator(tk.v);
        }
        expectOperator = false;
        atStatementStart = false;
        pendingStart = null;

        const next = toks[k + 1];
        if (tk.v === 'ago' && next?.t === 'lparen') {
          const num = toks[k + 2];
          const unit = toks[k + 3];
          const mult = unit?.t === 'word' ? UNIT_SECONDS[unit.v] : undefined;
          const value = num?.t === 'num' ? Number(num.v) : NaN;
          if (mult !== undefined && Number.isFinite(value)) {
            maxAgoSeconds = Math.max(maxAgoSeconds, value * mult);
          } else {
            sawUnparsableAgo = true;
          }
        } else if (tk.v === 'datetime' && next?.t === 'lparen') {
          sawDatetime = true;
          // datetime(null) is a value, not a bound: skipped.
          if (tk.ts === undefined) sawUnparsableDatetime = true;
          else if (tk.ts !== null) {
            const p1 = toks[k - 1];
            const p2 = toks[k - 2];
            if (p1?.t === 'other' && p1.bound) {
              // `col >= datetime(..)`: keep the column word to pair bounds.
              const col = p2?.t === 'word' ? p2.v : undefined;
              datetimes.push({ ts: tk.ts, k, bound: p1.bound, col });
            } else if (
              p1?.t === 'lparen' &&
              p2?.t === 'word' &&
              p2.v === 'between'
            ) {
              datetimes.push({ ts: tk.ts, k, bound: 'lo', col: BETWEEN });
            } else if (p1?.t === 'dot' && p2?.t === 'dot') {
              datetimes.push({ ts: tk.ts, k, bound: 'hi', col: BETWEEN });
            } else {
              datetimes.push({ ts: tk.ts, k });
            }
          }
        }
        continue;
      }
      expectOperator = false;
      atStatementStart = false;
      pendingStart = null;
    }

    let timeWindow = 'none';
    if (maxAgoSeconds >= 0) timeWindow = windowBucket(maxAgoSeconds);
    else if (sawUnparsableAgo) timeWindow = 'unknown';
    else if (sawDatetime) timeWindow = 'absolute';

    // Only for queries with datetime() literals. Needs exactly two that
    // parse and form one range: `between (a .. b)`, or `c >= a and c <= b`
    // on the same named column, in one statement, with no `or` between and
    // both at the same paren depth with no `)` closing a group opened before
    // the lower bound (another union/join branch, or a different `between`).
    let absoluteRange: string | undefined;
    if (sawDatetime) {
      const [lo, hi] = datetimes;
      const width =
        datetimes.length === 2
          ? hi.ts[0] - lo.ts[0] + (hi.ts[1] - lo.ts[1])
          : -1;
      let depth = 0;
      const sameGroup = (t: Tok) => {
        if (t.t === 'lparen') depth++;
        else if (t.t === 'rparen') depth--;
        return depth >= 0;
      };
      const isRange =
        !sawUnparsableDatetime &&
        datetimes.length === 2 &&
        lo.bound === 'lo' &&
        hi.bound === 'hi' &&
        lo.col !== undefined &&
        lo.col === hi.col &&
        width >= 0 &&
        !toks
          .slice(lo.k, hi.k)
          .some(t => t.t === 'semi' || (t.t === 'word' && t.v === 'or')) &&
        toks.slice(lo.k, hi.k).every(sameGroup) &&
        depth === 0;
      absoluteRange = isRange ? windowBucket(width) : 'unknown';
    }

    const score = pipes + 2 * joins + 2 * unions + lets;
    const complexity =
      score <= 1
        ? 'trivial'
        : score <= 3
          ? 'simple'
          : score <= 8
            ? 'moderate'
            : 'complex';

    return {
      [`${PREFIX}stmt_kind`]: 'query',
      [`${PREFIX}control_cmd`]: 'none',
      [`${PREFIX}operators`]: [...operators].sort(),
      [`${PREFIX}pipe_count`]: cap(pipes, PIPE_CAP),
      [`${PREFIX}join_count`]: cap(joins, COUNT_CAP),
      [`${PREFIX}union_count`]: cap(unions, COUNT_CAP),
      [`${PREFIX}let_count`]: cap(lets, COUNT_CAP),
      [`${PREFIX}time_window`]: timeWindow,
      [`${PREFIX}complexity_class`]: complexity,
      ...(absoluteRange && { [`${PREFIX}absolute_range`]: absoluteRange }),
    };
  } catch {
    // Telemetry must never fail a query.
    return unparsed;
  }
}
