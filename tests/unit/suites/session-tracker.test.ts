import { z } from 'zod';
import {
  coercePurpose,
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
  test('first query has no history', () => {
    const t = new SessionTracker();
    expect(t.beforeQuery(20)).toEqual({
      'kustomcp.session.prev_tool': 'none',
      'kustomcp.session.query_ordinal': '1',
      'kustomcp.session.schema_calls_before_query': '0',
      'kustomcp.query.retry_class': 'first',
      'kustomcp.query.limit_escalation': 'first',
    });
  });

  test('schema-first flow, then a retry after error with a raised limit', () => {
    const t = new SessionTracker();
    t.recordCall('initialize-connection', { status: 'ok' });
    t.recordCall('show-tables', { status: 'ok' });
    t.recordCall('show-table', { status: 'ok' });
    t.recordCall('show-table', { status: 'ok' });

    const a1 = t.beforeQuery(20);
    expect(a1['kustomcp.session.prev_tool']).toBe('show-table');
    expect(a1['kustomcp.session.schema_calls_before_query']).toBe('2-3');

    t.recordCall('execute-query', { status: 'error', limit: 20 });
    const a2 = t.beforeQuery(100);
    expect(a2['kustomcp.session.prev_tool']).toBe('execute-query');
    expect(a2['kustomcp.session.query_ordinal']).toBe('2');
    expect(a2['kustomcp.session.schema_calls_before_query']).toBe('0');
    expect(a2['kustomcp.query.retry_class']).toBe('after_error');
    expect(a2['kustomcp.query.limit_escalation']).toBe('raised');
  });

  test('retry classes and limit escalation', () => {
    const t = new SessionTracker();
    t.recordCall('execute-query', { status: 'ok', limit: 50, partial: true });
    let a = t.beforeQuery(50);
    expect(a['kustomcp.query.retry_class']).toBe('after_partial');
    expect(a['kustomcp.query.limit_escalation']).toBe('same');

    t.recordCall('execute-query', { status: 'ok', limit: 50, reduced: true });
    a = t.beforeQuery(10);
    expect(a['kustomcp.query.retry_class']).toBe('after_reduced');
    expect(a['kustomcp.query.limit_escalation']).toBe('lowered');

    t.recordCall('execute-query', { status: 'ok', limit: 10 });
    expect(t.beforeQuery(10)['kustomcp.query.retry_class']).toBe(
      'after_success',
    );
  });

  test('unknown tool names collapse to other and never ship verbatim', () => {
    const t = new SessionTracker();
    t.recordCall('secret-tool-name-with-PII', { status: 'ok' });
    expect(t.beforeQuery(20)['kustomcp.session.prev_tool']).toBe('other');
  });

  test('all emitted values stay within the declared vocabularies', () => {
    const t = new SessionTracker();
    const tools = [
      'show-tables',
      'show-table',
      'execute-query',
      'report-issue',
      'bogus',
    ];
    for (let i = 0; i < 40; i++) {
      const a = t.beforeQuery(i % 7 === 0 ? 1000 : 20);
      expect(PREV_TOOLS).toContain(a['kustomcp.session.prev_tool']);
      expect(ORDINAL_BUCKETS).toContain(a['kustomcp.session.query_ordinal']);
      expect(SCHEMA_CALL_BUCKETS).toContain(
        a['kustomcp.session.schema_calls_before_query'],
      );
      expect(RETRY_CLASSES).toContain(a['kustomcp.query.retry_class']);
      expect(LIMIT_ESCALATIONS).toContain(a['kustomcp.query.limit_escalation']);
      t.recordCall(tools[i % tools.length], {
        status: i % 3 === 0 ? 'error' : 'ok',
        limit: 20,
        partial: i % 5 === 0,
      });
    }
  });
});

describe('purpose', () => {
  test('coercePurpose accepts only the fixed list', () => {
    for (const p of QUERY_PURPOSES) expect(coercePurpose(p)).toBe(p);
    for (const bad of [
      undefined,
      null,
      42,
      {},
      '',
      'SELECT secret FROM customers',
      'schema_discovery ',
      'x'.repeat(10_000),
    ]) {
      expect(coercePurpose(bad)).toBe('unspecified');
    }
  });

  test('a bad purpose never fails argument parsing', () => {
    const schema = z.object({
      purpose: z.enum(QUERY_PURPOSES).optional().catch(undefined),
      query: z.string(),
    });
    expect(schema.parse({ query: 'T', purpose: 'garbage' })).toEqual({
      query: 'T',
      purpose: undefined,
    });
    expect(schema.parse({ query: 'T' }).purpose).toBeUndefined();
    expect(schema.parse({ query: 'T', purpose: 'bulk_extract' }).purpose).toBe(
      'bulk_extract',
    );
  });
});
