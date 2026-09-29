/**
 * Privacy + correctness tests for query-shape telemetry. Every emitted value
 * must come from a frozen vocabulary (or be a capped number) — never from the
 * query text.
 */

import {
  classifyQueryShape,
  QUERY_COMPLEXITY_VOCAB,
  QUERY_CONTROL_CMD_VOCAB,
  QUERY_OPERATOR_VOCAB,
  QUERY_STMT_KIND_VOCAB,
  QUERY_TIME_WINDOW_VOCAB,
} from '../../../src/common/query-shape.js';

const P = 'kustomcp.query.';
const shape = (q: string) => classifyQueryShape(q);

function assertInVocabulary(attrs: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(attrs)) {
    expect(key.startsWith(P)).toBe(true);
    if (key === `${P}stmt_kind`) {
      expect(QUERY_STMT_KIND_VOCAB).toContain(value);
    } else if (key === `${P}control_cmd`) {
      expect(QUERY_CONTROL_CMD_VOCAB).toContain(value);
    } else if (key === `${P}operators`) {
      expect(Array.isArray(value)).toBe(true);
      expect((value as string[]).length).toBeLessThanOrEqual(8);
      for (const op of value as string[]) {
        expect(QUERY_OPERATOR_VOCAB).toContain(op);
      }
    } else if (key === `${P}time_window`) {
      expect(QUERY_TIME_WINDOW_VOCAB).toContain(value);
    } else if (key === `${P}complexity_class`) {
      expect(QUERY_COMPLEXITY_VOCAB).toContain(value);
    } else {
      expect(typeof value).toBe('number');
      expect(value as number).toBeGreaterThanOrEqual(0);
      expect(value as number).toBeLessThanOrEqual(20);
    }
  }
}

describe('classifyQueryShape', () => {
  test('simple pipeline', () => {
    const a = shape('StormEvents | where State == "TX" | summarize count() by X');
    expect(a[`${P}stmt_kind`]).toBe('query');
    expect(a[`${P}operators`]).toEqual(['summarize', 'where']);
    expect(a[`${P}pipe_count`]).toBe(2);
    expect(a[`${P}join_count`]).toBe(0);
    expect(a[`${P}time_window`]).toBe('none');
    expect(a[`${P}complexity_class`]).toBe('simple');
  });

  test('joins, unions, lets and lookback window', () => {
    const a = shape(
      `let n = 5;
       union T1, T2
       | where Timestamp > ago(7d)
       | join kind=inner (U | where Timestamp > ago(30m)) on Id
       | take 10`,
    );
    expect(a[`${P}let_count`]).toBe(1);
    expect(a[`${P}union_count`]).toBe(1);
    expect(a[`${P}join_count`]).toBe(1);
    expect(a[`${P}time_window`]).toBe('<=7d');
    expect(a[`${P}operators`]).toEqual(['join', 'take', 'union', 'where']);
  });

  test.each([
    ['T | where t > ago(30m)', '<=1h'],
    ['T | where t > ago(1h)', '<=1h'],
    ['T | where t > ago(12h)', '<=1d'],
    ['T | where t > ago(1d)', '<=1d'],
    ['T | where t > ago(30d)', '<=30d'],
    ['T | where t > ago(365d)', '>30d'],
    ['T | where t > ago(N)', 'unknown'],
    ['T | where t > datetime(2024-01-01)', 'absolute'],
    ['T | take 5', 'none'],
  ])('time window: %s -> %s', (q, expected) => {
    expect(shape(q)[`${P}time_window`]).toBe(expected);
  });

  test('control commands', () => {
    expect(shape('.show tables')).toEqual({
      [`${P}stmt_kind`]: 'control_show',
      [`${P}control_cmd`]: 'tables',
    });
    expect(shape('.show table Secret_Table details')[`${P}control_cmd`]).toBe(
      'table',
    );
    expect(shape('.show my_secret_thing')[`${P}control_cmd`]).toBe('other');
    expect(shape('.create-or-alter function F() {1}')[`${P}stmt_kind`]).toBe(
      'control_create',
    );
    expect(shape('.set-or-append T <| X')[`${P}stmt_kind`]).toBe(
      'control_ingest',
    );
    expect(shape('.drop table T')[`${P}stmt_kind`]).toBe('control_drop');
  });

  test('hyphenated operators map to their family', () => {
    const a = shape('T | project-away A | mv-expand B | make-series c=count() on t');
    expect(a[`${P}operators`]).toEqual(['make_series', 'mv_expand', 'project']);
  });

  describe('adversarial inputs never leak or miscount', () => {
    test('operator names inside strings and comments are ignored', () => {
      const a = shape(
        'T | where Msg == "| join | summarize" // | union X\n| take 1',
      );
      expect(a[`${P}operators`]).toEqual(['take', 'where']);
      expect(a[`${P}join_count`]).toBe(0);
    });

    test('a column or table named like an operator is not counted', () => {
      const a = shape('join | project join, summarize, union | take 3');
      expect(a[`${P}join_count`]).toBe(0);
      expect(a[`${P}union_count`]).toBe(0);
      expect(a[`${P}operators`]).toEqual(['project', 'take']);
    });

    test('unknown operators collapse to other; the name never ships', () => {
      const a = shape('T | secretoperatorname | take 1');
      expect(a[`${P}operators`]).toEqual(['other', 'take']);
      expect(JSON.stringify(a)).not.toContain('secretoperatorname');
    });

    test('verbatim strings with doubled quotes, backticks, brackets', () => {
      const a = shape(
        `T | where a == @"x""| join y" | where ['my | join table'] == \`\`\`| union\`\`\` | take 1`,
      );
      expect(a[`${P}join_count`]).toBe(0);
      expect(a[`${P}union_count`]).toBe(0);
      expect(a[`${P}operators`]).toEqual(['take', 'where']);
    });

    test('unterminated string, bracket or fence -> unparsed', () => {
      for (const q of ['T | where a == "oops', "T | where a == 'x", 'T | [x', '```abc']) {
        expect(shape(q)).toEqual({ [`${P}stmt_kind`]: 'unparsed' });
      }
    });

    test('oversize query -> unparsed, no scan', () => {
      const big = 'T | take 1 // ' + 'x'.repeat(70_000);
      expect(shape(big)).toEqual({ [`${P}stmt_kind`]: 'unparsed' });
    });

    test('non-string input never throws', () => {
      for (const v of [undefined, null, 42, {}, []]) {
        expect(() => classifyQueryShape(v as unknown as string)).not.toThrow();
      }
    });

    test('counts are capped', () => {
      const q = 'T' + ' | join U on x'.repeat(50) + ' | take 1';
      const a = shape(q);
      expect(a[`${P}join_count`]).toBe(10);
      expect(a[`${P}pipe_count`]).toBe(20);
    });

    test('secrets in any position never reach an attribute value', () => {
      const secrets = [
        'p@ssw0rd-DO-NOT-LEAK',
        'AcmeCorpCustomers',
        'user@contoso.com',
      ];
      const queries = [
        `AcmeCorpCustomers | where Email == "user@contoso.com" and Pw == "p@ssw0rd-DO-NOT-LEAK"`,
        `let AcmeCorpCustomers = 1; cluster('user@contoso.com').database('x').T | take 1`,
        `.show table AcmeCorpCustomers`,
        `T | AcmeCorpCustomers | p@ssw0rd`,
      ];
      for (const q of queries) {
        const out = JSON.stringify(shape(q));
        for (const secret of secrets) {
          expect(out).not.toContain(secret);
        }
      }
    });
  });

  test('fuzz: every emitted value is in a frozen vocabulary', () => {
    const alphabet = [
      '|', ' ', '\n', ';', '(', ')', '"', "'", '`', '[', ']', '@', '.', '-',
      '//', 'join', 'union', 'let', 'where', 'ago', '7d', 'datetime', 'foo',
      'bar_baz', '.show', 'tables', '.create', '1', '=', ',',
    ];
    let seed = 12345;
    const rand = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
    for (let i = 0; i < 2000; i++) {
      let q = '';
      const len = Math.floor(rand() * 40);
      for (let j = 0; j < len; j++) {
        q += alphabet[Math.floor(rand() * alphabet.length)];
      }
      assertInVocabulary(classifyQueryShape(q));
    }
  });
});
