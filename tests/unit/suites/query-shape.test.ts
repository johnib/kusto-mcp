/**
 * Privacy + correctness tests for query-shape telemetry. Every emitted value
 * must come from a frozen vocabulary (or be a capped number) — never from the
 * query text.
 */

import {
  classifyQueryShape,
  QUERY_ABSOLUTE_RANGE_VOCAB,
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
      expect((value as string[]).length).toBeLessThanOrEqual(
        QUERY_OPERATOR_VOCAB.length,
      );
      for (const op of value as string[]) {
        expect(QUERY_OPERATOR_VOCAB).toContain(op);
      }
    } else if (key === `${P}time_window`) {
      expect(QUERY_TIME_WINDOW_VOCAB).toContain(value);
    } else if (key === `${P}absolute_range`) {
      expect(QUERY_ABSOLUTE_RANGE_VOCAB).toContain(value);
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
    const a = shape(
      'StormEvents | where State == "TX" | summarize count() by X',
    );
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

  test.each([
    [
      'T | where t between (datetime(2024-01-01) .. datetime(2024-01-01 00:30))',
      '<=1h',
    ],
    [
      'T | where t >= datetime(2024-01-01T00:00:00Z) and t <= datetime(2024-01-02T00:00:00Z)',
      '<=1d',
    ],
    [
      'T | where t >= datetime("2024-01-01") and t < datetime("2024-01-05 12:00:00.123")',
      '<=7d',
    ],
    [
      'T | where t between(datetime(2024-01-01)..datetime(2024-01-31))',
      '<=30d',
    ],
    // datetime(null) is a value, not a bound.
    [
      'T | where t between (datetime(2024-01-01) .. datetime(2024-01-02)) | extend x = iff(isnull(y), datetime(null), y)',
      '<=1d',
    ],
    // One bound only, a literal that doesn't parse, arithmetic on a literal,
    // bounds out of order or more than two literals: no range.
    [
      'T | where t > datetime(2024-06-01) | where t < datetime(2023-01-01)',
      'unknown',
    ],
    [
      'T | where t >= datetime(2024-01-01) and t < datetime(2024-01-01) + 2d',
      'unknown',
    ],
    [
      'T | where t between (datetime(2024-01-01) .. datetime(2024-01-02)) | summarize count() by bin_at(t, 1h, datetime(2024-01-01))',
      'unknown',
    ],
    // Two literals that are not one filter range.
    ['print datetime(2024-01-01), datetime(2024-01-02)', 'unknown'],
    ['T | extend a=datetime(2024-01-01), b=datetime(2024-01-02)', 'unknown'],
    [
      'T | where t >= datetime(2024-01-01) or t <= datetime(2024-01-02)',
      'unknown',
    ],
    [
      'T | where a >= datetime(2024-01-01) and b <= datetime(2024-01-02)',
      'unknown',
    ],
    // Days the month doesn't have don't parse.
    [
      'T | where t between (datetime(2024-02-30) .. datetime(2024-03-01))',
      'unknown',
    ],
    [
      'T | where t between (datetime(2023-02-29) .. datetime(2023-03-01))',
      'unknown',
    ],
    [
      'T | where t between (datetime(2024-04-31) .. datetime(2024-05-01))',
      'unknown',
    ],
    // Leap day and year 0001 do.
    [
      'T | where t between (datetime(2024-02-29) .. datetime(2024-03-01))',
      '<=1d',
    ],
    [
      'T | where t between (datetime(0001-01-01) .. datetime(0001-01-01 00:30))',
      '<=1h',
    ],
    ['T | where t > datetime(2024-01-01)', 'unknown'],
    [
      'T | where t between (datetime(2024-01-01) .. datetime(2024-13-01))',
      'unknown',
    ],
    ['T | where t between (datetime(x) .. datetime(2024-01-02))', 'unknown'],
    ['T | where t > datetime(null)', 'unknown'],
  ])('absolute range: %s -> %s', (q, expected) => {
    const a = shape(q);
    expect(a[`${P}absolute_range`]).toBe(expected);
    // The existing lookback bucket is unchanged.
    expect(a[`${P}time_window`]).toBe('absolute');
    assertInVocabulary(a);
  });

  test('absolute range is absent without datetime() literals', () => {
    expect(shape('T | where t > ago(1d)')).not.toHaveProperty(
      `${P}absolute_range`,
    );
    expect(shape('T | take 5')).not.toHaveProperty(`${P}absolute_range`);
    // A literal inside a string or comment is not a datetime() call.
    expect(
      shape('T | where s == "datetime(2024-01-01)" // datetime(2024-02-01)'),
    ).not.toHaveProperty(`${P}absolute_range`);
    // With ago() present, time_window keeps the ago() bucket.
    const a = shape(
      'T | where t > ago(2h) and t between (datetime(2024-01-01) .. datetime(2024-03-01))',
    );
    expect(a[`${P}time_window`]).toBe('<=1d');
    expect(a[`${P}absolute_range`]).toBe('>30d');
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

  test('standalone operators that start a statement are classified', () => {
    expect(shape('search "timeout"')[`${P}operators`]).toEqual(['search']);
    expect(shape('find where x == 1')[`${P}operators`]).toEqual(['find']);
    expect(shape('externaldata (a:string) [h@"u"]')[`${P}operators`]).toEqual([
      'externaldata',
    ]);
    expect(shape('evaluate plugin()')[`${P}operators`]).toEqual(['evaluate']);
    // A table that merely shares an operator's name is still not counted.
    expect(shape('join | take 1')[`${P}operators`]).toEqual(['take']);
  });

  test('union inside let bindings and nested expressions is classified', () => {
    const a = shape('let Combined = union TableA, TableB;\nCombined | count');
    expect(a[`${P}union_count`]).toBe(1);
    expect(a[`${P}let_count`]).toBe(1);
    expect(a[`${P}operators`]).toEqual(['count', 'union']);

    const b = shape('T | join (union U, V) on Key');
    expect(b[`${P}union_count`]).toBe(1);
    expect(b[`${P}join_count`]).toBe(1);

    const c = shape('let x = (union A, B); x | take 1');
    expect(c[`${P}union_count`]).toBe(1);
  });

  test('union at the start of a let function/view body is classified', () => {
    const f = shape('let Combined = () { union TableA, TableB };\nCombined()');
    expect(f[`${P}union_count`]).toBe(1);
    expect(f[`${P}operators`]).toEqual(['union']);

    const v = shape(
      'let V = view () { union TableA, TableB };\nunion V, TableC',
    );
    expect(v[`${P}union_count`]).toBe(2);

    // Scalar/dynamic braces and non-tabular bodies are not misread.
    expect(
      shape('let d = dynamic({"a": 1}); T | take 1')[`${P}operators`],
    ).toEqual(['take']);
    expect(
      shape('let f = (x:string) { x | take 1 }; f("a")')[`${P}operators`],
    ).toEqual(['take']);
    expect(shape('T | where a == "{ union X }"')[`${P}union_count`]).toBe(0);
  });

  test('words after = / ( that are plain names are not operators', () => {
    // `==` is a comparison, not a let binding; `union` as a column name in a
    // call is only counted after `(` (accepted residual), `search` never is.
    expect(shape('let a = 1; T | where x == union')[`${P}union_count`]).toBe(0);
    expect(shape('T | where f(search) > 1')[`${P}operators`]).toEqual([
      'where',
    ]);
    expect(shape('let n = 5; T | take n')[`${P}operators`]).toEqual(['take']);
  });

  test('hyphenated operators map to their family', () => {
    const a = shape(
      'T | project-away A | mv-expand B | make-series c=count() on t',
    );
    expect(a[`${P}operators`]).toEqual(['make_series', 'mv_expand', 'project']);
  });

  test('all operator families are reported, not just the first 8 (#317)', () => {
    const a = shape(
      'T | where x > 1 | extend y = 2 | join (U) on k | distinct k, y' +
        ' | count | parse s with v | project k | render table' +
        ' | sort by k | summarize n = count() by k | take 5 | top 3 by n' +
        ' | union V',
    );
    assertInVocabulary(a);
    expect(a[`${P}operators`]).toEqual([
      'count',
      'distinct',
      'extend',
      'join',
      'parse',
      'project',
      'render',
      'sort',
      'summarize',
      'take',
      'top',
      'union',
      'where',
    ]);
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
      for (const q of [
        'T | where a == "oops',
        "T | where a == 'x",
        'T | [x',
        '```abc',
      ]) {
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
      '|',
      ' ',
      '\n',
      ';',
      '(',
      ')',
      '"',
      "'",
      '`',
      '[',
      ']',
      '@',
      '.',
      '-',
      '//',
      'join',
      'union',
      'let',
      'where',
      'ago',
      '7d',
      'datetime',
      'datetime(2024-01-01)',
      'datetime(2024-01-02 03:04)',
      '..',
      'foo',
      'bar_baz',
      '.show',
      'tables',
      '.create',
      '1',
      '=',
      ',',
    ];
    let seed = 12345;
    const rand = () =>
      (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
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
