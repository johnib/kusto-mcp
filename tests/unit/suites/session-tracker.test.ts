import { z } from 'zod';
import {
  classifyPurpose,
  QUERY_PURPOSES,
} from '../../../src/common/query-purpose.js';
import {
  LIMIT_ESCALATIONS,
  ORDINAL_BUCKETS,
  PREV_TOOLS,
  RETRY_CLASSES,
  SCHEMA_CALL_BUCKETS,
  SessionTracker,
} from '../../../src/common/session-tracker.js';

describe('SessionTracker', () => {
  const run = (
    t: SessionTracker,
    limit: number,
    result: { status: string; partial?: boolean; reduced?: boolean },
  ) => {
    const q = t.beginQuery(limit);
    q.finish(result);
    return q.attributes;
  };

  test('first query has no history', () => {
    const t = new SessionTracker();
    expect(t.beginQuery(20).attributes).toEqual({
      'kustomcp.session.prev_tool': 'none',
      'kustomcp.session.query_ordinal': '1',
      'kustomcp.session.schema_calls_before_query': '0',
      'kustomcp.query.retry_class': 'first',
      'kustomcp.query.limit_escalation': 'first',
    });
  });

  test('schema-first flow, then a retry after error with a raised limit', () => {
    const t = new SessionTracker();
    t.recordCall('initialize-connection');
    t.recordCall('show-tables');
    t.recordCall('show-table');
    t.recordCall('show-table');

    const a1 = run(t, 20, { status: 'error' });
    expect(a1['kustomcp.session.prev_tool']).toBe('show-table');
    expect(a1['kustomcp.session.schema_calls_before_query']).toBe('2-3');

    const a2 = run(t, 100, { status: 'ok' });
    expect(a2['kustomcp.session.prev_tool']).toBe('execute-query');
    expect(a2['kustomcp.session.query_ordinal']).toBe('2');
    expect(a2['kustomcp.session.schema_calls_before_query']).toBe('0');
    expect(a2['kustomcp.query.retry_class']).toBe('after_error');
    expect(a2['kustomcp.query.limit_escalation']).toBe('raised');
  });

  test('retry classes and limit escalation', () => {
    const t = new SessionTracker();
    run(t, 50, { status: 'ok', partial: true });
    let a = run(t, 50, { status: 'ok', reduced: true });
    expect(a['kustomcp.query.retry_class']).toBe('after_partial');
    expect(a['kustomcp.query.limit_escalation']).toBe('same');

    a = run(t, 10, { status: 'ok' });
    expect(a['kustomcp.query.retry_class']).toBe('after_reduced');
    expect(a['kustomcp.query.limit_escalation']).toBe('lowered');

    a = run(t, 10, { status: 'ok' });
    expect(a['kustomcp.query.retry_class']).toBe('after_success');

    t.beginQuery(10); // left unfinished
    a = t.beginQuery(10).attributes;
    expect(a['kustomcp.query.retry_class']).toBe('after_in_flight');
  });

  test('overlapping queries get distinct ordinals and see the in-flight one', () => {
    const t = new SessionTracker();
    const first = t.beginQuery(100);
    const second = t.beginQuery(100); // starts before `first` finished
    expect(first.attributes['kustomcp.session.query_ordinal']).toBe('1');
    expect(second.attributes['kustomcp.session.query_ordinal']).toBe('2');
    expect(second.attributes['kustomcp.query.retry_class']).toBe(
      'after_in_flight',
    );
    expect(second.attributes['kustomcp.query.limit_escalation']).toBe('same');

    // Finishing out of order: only the latest query owns the outcome state.
    second.finish({ status: 'ok' });
    first.finish({ status: 'error' });
    expect(t.beginQuery(100).attributes['kustomcp.query.retry_class']).toBe(
      'after_success',
    );
  });

  test('unknown tool names collapse to other and never ship verbatim', () => {
    const t = new SessionTracker();
    t.recordCall('secret-tool-name-with-PII');
    expect(t.beginQuery(20).attributes['kustomcp.session.prev_tool']).toBe(
      'other',
    );
  });

  test('all emitted values stay within the declared vocabularies', () => {
    const t = new SessionTracker();
    const tools = ['show-tables', 'show-table', 'report-issue', 'bogus'];
    for (let i = 0; i < 40; i++) {
      const q = t.beginQuery(i % 7 === 0 ? 1000 : 20);
      const a = q.attributes;
      expect(PREV_TOOLS).toContain(a['kustomcp.session.prev_tool']);
      expect(ORDINAL_BUCKETS).toContain(a['kustomcp.session.query_ordinal']);
      expect(SCHEMA_CALL_BUCKETS).toContain(
        a['kustomcp.session.schema_calls_before_query'],
      );
      expect(RETRY_CLASSES).toContain(a['kustomcp.query.retry_class']);
      expect(LIMIT_ESCALATIONS).toContain(a['kustomcp.query.limit_escalation']);
      if (i % 4 !== 0) {
        q.finish({
          status: i % 3 === 0 ? 'error' : 'ok',
          partial: i % 5 === 0,
        });
      }
      t.recordCall(tools[i % tools.length]);
    }
  });
});

describe('purpose', () => {
  test('known labels pass through, case/hyphen-insensitive', () => {
    for (const p of QUERY_PURPOSES) {
      expect(classifyPurpose(p)).toEqual({ purpose: p });
    }
    expect(classifyPurpose(' Schema-Discovery ')).toEqual({
      purpose: 'schema_discovery',
    });
  });

  test('absent or non-string is unspecified', () => {
    for (const v of [undefined, null, 42, {}, [], '', '   ']) {
      expect(classifyPurpose(v)).toEqual({ purpose: 'unspecified' });
    }
  });

  test('any unlisted value is captured exactly as sent', () => {
    for (const custom of [
      'fraud_review',
      'Capacity-Planning',
      'Find storms in Texas',
      'billing.audit/2024',
      '1st_pass',
      '  padded  ',
    ]) {
      expect(classifyPurpose(custom)).toEqual({
        purpose: 'other',
        unlisted: custom,
      });
    }
  });

  test('unlisted values are length-capped, not dropped', () => {
    const out = classifyPurpose('x'.repeat(10_000));
    expect(out.purpose).toBe('other');
    expect(out.unlisted).toHaveLength(512);
  });

  test('a bad purpose never fails argument parsing', () => {
    const schema = z.object({
      purpose: z.string().optional().catch(undefined),
      query: z.string(),
    });
    expect(schema.parse({ query: 'T', purpose: 42 })).toEqual({
      query: 'T',
      purpose: undefined,
    });
    expect(schema.parse({ query: 'T' }).purpose).toBeUndefined();
    expect(schema.parse({ query: 'T', purpose: 'anything goes' }).purpose).toBe(
      'anything goes',
    );
  });
});
