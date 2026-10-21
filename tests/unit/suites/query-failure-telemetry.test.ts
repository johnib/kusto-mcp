/**
 * Bounded failure telemetry for execute-query:
 *  - "Connection not initialized" is its own error type (NotInitialized),
 *    failure category and retry class, not a KustoQueryError / after_error.
 *  - kusto.query and the execute-query span carry
 *    kustomcp.query.failure_category (+ kustomcp.http.status_code on
 *    kusto.query), derived from status / code / class, never the message.
 *  - execute-query spans carry kustomcp.session.failure_streak and
 *    kustomcp.hint.fired.
 *  - retry_class splits after_timeout / after_empty off after_error /
 *    after_success, and after_in_flight comes with last_completed_outcome.
 *
 * Drives the real tool-call handler, KustoConnection and queries.executeQuery;
 * only the azure-kusto-data Client (mocked in setup.ts) is routed.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { Client as KustoClient } from 'azure-kusto-data';
import {
  FAILURE_CATEGORIES,
  getFailureCategory,
} from '../../../src/common/errors.js';
import {
  FAILURE_STREAK_BUCKETS,
  failureStreakBucket,
  LAST_COMPLETED_OUTCOMES,
  RETRY_CLASSES,
  SessionTracker,
} from '../../../src/common/session-tracker.js';
import { KustoConnection } from '../../../src/operations/kusto/connection.js';
import { executeQuery } from '../../../src/operations/kusto/queries.js';
import { createKustoServer } from '../../../src/server.js';
import { AuthenticationMethod } from '../../../src/types/config.js';

jest.mock('../../../src/common/version.js', () => ({ VERSION: '0.0.0-test' }));

const spans = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(spans)],
});

const execute = jest.spyOn(
  KustoClient.prototype as unknown as {
    execute: (db: string, q: string) => Promise<unknown>;
  },
  'execute',
);

const rows = (n: number) => ({
  primaryResults: [
    {
      name: 'r',
      columns: [{ ColumnName: 'a' }],
      _rows: Array.from({ length: n }, (_, i) => [i]),
    },
  ],
});

const withStatus = (status: number) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status },
  });

const HINT =
  'Several queries failed in a row – check the table schema with show-table and simplify the query.';

const named = (name: string) =>
  spans.getFinishedSpans().filter(s => s.name === name);
const toolSpans = () => named('mcp.tool/execute-query');
const last = <T>(a: T[]) => a[a.length - 1];

async function startServer(config: { queryTimeout?: number } = {}) {
  const server = createKustoServer({
    authMethod: AuthenticationMethod.AzureCli,
    ...config,
  });
  const client = new Client({ name: 'unit-test', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return {
    client,
    init: async () => {
      const r = await client.callTool({
        name: 'initialize-connection',
        arguments: {
          cluster_url: 'https://x.kusto.windows.net',
          database: 'd',
        },
      });
      expect(r.isError).toBeFalsy();
    },
    query: (query = 'T | take 1') =>
      client.callTool({ name: 'execute-query', arguments: { query } }),
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

const text = (r: Awaited<ReturnType<Client['callTool']>>) =>
  (r.content as Array<{ type: string; text: string }>)[0].text;

beforeAll(() => provider.register());
beforeEach(() => {
  spans.reset();
  execute.mockReset();
  execute.mockResolvedValue(rows(1));
});

describe('kusto.query failure_category and http.status_code', () => {
  async function failWith(error: unknown) {
    const connection = new KustoConnection({
      authMethod: AuthenticationMethod.AzureCli,
    });
    await connection.initialize('https://x.kusto.windows.net', 'd');
    spans.reset();
    execute.mockRejectedValueOnce(error);
    let thrown: unknown;
    await executeQuery(connection, 'T | take 1').catch(e => (thrown = e));
    const attrs = last(named('kusto.query')).attributes;
    return { attrs, thrown };
  }

  test.each<[string, () => unknown, string, number | undefined]>([
    [
      'KQL semantic error (HTTP 400)',
      () => withStatus(400),
      'query_semantic',
      400,
    ],
    // A missing database is a 400 too, but not a KQL mistake.
    [
      'database not found (HTTP 400, BadRequest_EntityNotFound)',
      () =>
        Object.assign(withStatus(400), {
          response: {
            status: 400,
            data: { error: { code: 'BadRequest_EntityNotFound' } },
          },
        }),
      'other',
      400,
    ],
    // A '429' in the message (e.g. an identifier) is not throttling.
    [
      'HTTP 400 whose message mentions 429',
      () =>
        Object.assign(new Error("Failed to resolve 'Event429'"), {
          response: { status: 400 },
        }),
      'query_semantic',
      400,
    ],
    ['HTTP 401', () => withStatus(401), 'auth_forbidden', 401],
    ['HTTP 403', () => withStatus(403), 'auth_forbidden', 403],
    [
      'KustoAuthenticationError',
      () => Object.assign(new Error('x'), { name: 'KustoAuthenticationError' }),
      'auth_forbidden',
      undefined,
    ],
    ['HTTP 429', () => withStatus(429), 'throttled', 429],
    ['HTTP 503', () => withStatus(503), 'server_error', 503],
    ['HTTP 404', () => withStatus(404), 'other', 404],
    // Not our query deadline: outcome stays 'error', so not 'timeout'.
    ['HTTP 408', () => withStatus(408), 'other', 408],
    [
      'ECONNREFUSED',
      () => Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
      'network',
      undefined,
    ],
    [
      'nested ENOTFOUND',
      () => Object.assign(new Error('x'), { cause: { code: 'ENOTFOUND' } }),
      'network',
      undefined,
    ],
    [
      'ETIMEDOUT',
      () => Object.assign(new Error('x'), { code: 'ETIMEDOUT' }),
      'network',
      undefined,
    ],
    [
      'structured server timeout (HTTP 400)',
      () =>
        Object.assign(withStatus(400), {
          response: {
            status: 400,
            data: { error: { code: 'RequestExecutionTimeout' } },
          },
        }),
      'timeout',
      400,
    ],
    // The message names a semantic error, but without a status the
    // category must not be guessed from the text.
    [
      'plain error mentioning a semantic error',
      () => new Error("Semantic error: 'x' is not a column"),
      'other',
      undefined,
    ],
  ])('%s', async (_label, make, category, status) => {
    const { attrs, thrown } = await failWith(make());
    expect(attrs['kustomcp.query.failure_category']).toBe(category);
    expect(attrs['kustomcp.http.status_code']).toBe(status);
    expect(FAILURE_CATEGORIES).toContain(
      attrs['kustomcp.query.failure_category'],
    );
    // Survives the re-wrapping layers, for the execute-query span.
    expect(getFailureCategory(thrown)).toBe(category);
  });

  test('no category or status on success', async () => {
    const connection = new KustoConnection({
      authMethod: AuthenticationMethod.AzureCli,
    });
    await connection.initialize('https://x.kusto.windows.net', 'd');
    spans.reset();
    await executeQuery(connection, 'T | take 1');
    const attrs = last(named('kusto.query')).attributes;
    expect(attrs['kustomcp.query.failure_category']).toBeUndefined();
    expect(attrs['kustomcp.http.status_code']).toBeUndefined();
  });

  test('a query on a connection with no client is NotInitialized / not_connected', async () => {
    const connection = new KustoConnection({
      authMethod: AuthenticationMethod.AzureCli,
    });
    await expect(connection.executeQuery('d', 'T')).rejects.toThrow(
      'Connection not initialized',
    );
    const attrs = last(named('kusto.query')).attributes;
    expect(attrs['kustomcp.query.failure_category']).toBe('not_connected');
    expect(attrs['kustomcp.error.type']).toBe('NotInitialized');
  });

  test('queries.executeQuery on an uninitialized connection is NotInitialized, not KustoQueryError', async () => {
    const connection = new KustoConnection({
      authMethod: AuthenticationMethod.AzureCli,
    });
    let thrown: unknown;
    await executeQuery(connection, 'T').catch(e => (thrown = e));
    expect((thrown as Error).name).toBe('KustoQueryError'); // user-facing class unchanged
    expect(getFailureCategory(thrown)).toBe('not_connected');
    const attrs = last(named('executeQuery')).attributes;
    expect(attrs['kustomcp.error.type']).toBe('NotInitialized');
  });
});

describe('execute-query span', () => {
  test('not connected: NotInitialized, not_connected, after_not_connected, out of the streak', async () => {
    const s = await startServer();
    try {
      const r = await s.query();
      expect(r.isError).toBe(true);
      // User-facing text is unchanged.
      expect(text(r)).toContain('Connection not initialized');
      await s.query();

      const [first, second] = toolSpans();
      expect(first.attributes['kustomcp.error.type']).toBe('NotInitialized');
      expect(first.attributes['kustomcp.query.failure_category']).toBe(
        'not_connected',
      );
      expect(first.attributes['kustomcp.session.failure_streak']).toBe('0');
      expect(first.attributes['kustomcp.hint.fired']).toBe('none');
      expect(second.attributes['kustomcp.query.retry_class']).toBe(
        'after_not_connected',
      );
    } finally {
      await s.close();
    }
  });

  test('show-* tools also record NotInitialized', async () => {
    const s = await startServer();
    try {
      await s.client.callTool({ name: 'show-tables', arguments: {} });
      const span = last(named('mcp.tool/show-tables'));
      expect(span.attributes['kustomcp.error.type']).toBe('NotInitialized');
    } finally {
      await s.close();
    }
  });

  test('KQL failures: failure_category, a growing streak and the failure_streak hint', async () => {
    const s = await startServer();
    try {
      await s.init();
      for (let i = 0; i < 6; i++)
        execute.mockRejectedValueOnce(withStatus(400));
      const results = [];
      for (let i = 0; i < 6; i++) results.push(await s.query());
      expect(text(results[2]).endsWith(`\n${HINT}`)).toBe(true);

      const attrs = toolSpans().map(sp => sp.attributes);
      expect(attrs.map(a => a['kustomcp.query.failure_category'])).toEqual(
        Array(6).fill('query_semantic'),
      );
      expect(attrs.map(a => a['kustomcp.session.failure_streak'])).toEqual([
        '1',
        '2',
        '3-4',
        '3-4',
        '5+',
        '5+',
      ]);
      expect(attrs.map(a => a['kustomcp.hint.fired'])).toEqual([
        'none',
        'none',
        'failure_streak',
        'failure_streak',
        'failure_streak',
        'failure_streak',
      ]);

      // A success resets the streak and carries no failure category.
      spans.reset();
      await s.query();
      const ok = last(toolSpans()).attributes;
      expect(ok['kustomcp.session.failure_streak']).toBe('0');
      expect(ok['kustomcp.hint.fired']).toBe('none');
      expect(ok['kustomcp.query.failure_category']).toBeUndefined();
      for (const v of attrs.map(a => a['kustomcp.session.failure_streak'])) {
        expect(FAILURE_STREAK_BUCKETS).toContain(v);
      }
    } finally {
      await s.close();
    }
  });

  test('timeout: timeout hint fired, timeout category, after_timeout', async () => {
    const s = await startServer({ queryTimeout: 30 });
    try {
      await s.init();
      execute.mockReturnValueOnce(new Promise(() => {}));
      const r = await s.query('T | where t > ago(1h) | take 1');
      expect(text(r)).toContain('Narrow the time range');
      await s.query();

      const [timedOut, next] = toolSpans();
      expect(timedOut.attributes['kustomcp.hint.fired']).toBe('timeout');
      expect(timedOut.attributes['kustomcp.query.failure_category']).toBe(
        'timeout',
      );
      expect(timedOut.attributes['kustomcp.session.failure_streak']).toBe('0');
      expect(next.attributes['kustomcp.query.retry_class']).toBe(
        'after_timeout',
      );
    } finally {
      await s.close();
    }
  });

  test('a socket ETIMEDOUT is a network error, not after_timeout', async () => {
    const s = await startServer();
    try {
      await s.init();
      execute.mockRejectedValueOnce(
        Object.assign(new Error('x'), { code: 'ETIMEDOUT' }),
      );
      await s.query();
      await s.query();
      const [failed, next] = toolSpans();
      expect(failed.attributes['kustomcp.query.failure_category']).toBe(
        'network',
      );
      expect(failed.attributes['kustomcp.hint.fired']).toBe('none');
      expect(next.attributes['kustomcp.query.retry_class']).toBe('after_error');
    } finally {
      await s.close();
    }
  });

  test('a 400 whose message mentions 429 still counts toward the streak', async () => {
    const s = await startServer();
    try {
      await s.init();
      for (let i = 0; i < 3; i++)
        execute.mockRejectedValueOnce(
          Object.assign(new Error("Failed to resolve 'Event429'"), {
            response: { status: 400 },
          }),
        );
      for (let i = 0; i < 3; i++) await s.query();
      const attrs = toolSpans().map(sp => sp.attributes);
      expect(attrs.map(a => a['kustomcp.session.failure_streak'])).toEqual([
        '1',
        '2',
        '3-4',
      ]);
      expect(last(attrs)['kustomcp.hint.fired']).toBe('failure_streak');
    } finally {
      await s.close();
    }
  });

  test('3rd not-connected call: not_initialized_stop hint fired', async () => {
    const s = await startServer();
    try {
      for (let i = 0; i < 3; i++) await s.query();
      const attrs = toolSpans().map(sp => sp.attributes['kustomcp.hint.fired']);
      expect(attrs).toEqual(['none', 'none', 'not_initialized_stop']);
    } finally {
      await s.close();
    }
  });

  test('0 rows: empty_result hint fired', async () => {
    const s = await startServer();
    try {
      await s.init();
      execute.mockResolvedValueOnce(rows(0));
      const r = await s.query();
      expect(text(r)).toContain('No rows matched');
      await s.query();
      const [empty, next] = toolSpans();
      expect(empty.attributes['kustomcp.hint.fired']).toBe('empty_result');
      expect(next.attributes['kustomcp.hint.fired']).toBe('none');
    } finally {
      await s.close();
    }
  });

  test('invalid arguments still carry failure_streak and hint.fired', async () => {
    const s = await startServer();
    try {
      await s.client.callTool({ name: 'execute-query', arguments: {} });
      const a = last(toolSpans()).attributes;
      expect(a['kustomcp.query.outcome']).toBe('invalid_args');
      expect(a['kustomcp.session.failure_streak']).toBe('0');
      expect(a['kustomcp.hint.fired']).toBe('none');
    } finally {
      await s.close();
    }
  });

  test('a successful query with 0 rows makes the next one after_empty', async () => {
    const s = await startServer();
    try {
      await s.init();
      execute.mockResolvedValueOnce(rows(0));
      await s.query();
      await s.query();
      await s.query();
      const [, afterEmpty, afterSuccess] = toolSpans();
      expect(afterEmpty.attributes['kustomcp.query.retry_class']).toBe(
        'after_empty',
      );
      expect(afterSuccess.attributes['kustomcp.query.retry_class']).toBe(
        'after_success',
      );
    } finally {
      await s.close();
    }
  });
});

describe('SessionTracker failure classes', () => {
  const run = (
    t: SessionTracker,
    result: Parameters<ReturnType<SessionTracker['beginQuery']>['finish']>[0],
  ) => {
    const q = t.beginQuery(20);
    q.finish(result);
    return q.attributes;
  };
  const retryClassAfter = (
    result: Parameters<ReturnType<SessionTracker['beginQuery']>['finish']>[0],
  ) => {
    const t = new SessionTracker();
    run(t, result);
    return t.beginQuery(20).attributes['kustomcp.query.retry_class'];
  };

  test.each<
    [
      string,
      Parameters<ReturnType<SessionTracker['beginQuery']>['finish']>[0],
      string,
    ]
  >([
    [
      'timeout',
      { status: 'error', failureCategory: 'timeout' },
      'after_timeout',
    ],
    [
      'not connected',
      {
        status: 'error',
        failureCategory: 'not_connected',
        countsAsQueryFailure: false,
      },
      'after_not_connected',
    ],
    [
      'KQL error',
      { status: 'error', failureCategory: 'query_semantic' },
      'after_error',
    ],
    [
      'throttled',
      { status: 'error', failureCategory: 'throttled' },
      'after_error',
    ],
    ['empty', { status: 'ok', rowCount: 0 }, 'after_empty'],
    ['rows', { status: 'ok', rowCount: 3 }, 'after_success'],
    [
      'partial wins over rowCount',
      { status: 'ok', partial: true, rowCount: 0 },
      'after_partial',
    ],
  ])('%s -> %s', (_label, result, expected) => {
    expect(retryClassAfter(result)).toBe(expected);
    expect(RETRY_CLASSES).toContain(expected);
  });

  test('after_in_flight carries last_completed_outcome; others do not', () => {
    const t = new SessionTracker();
    const first = t.beginQuery(20);
    expect(
      first.attributes['kustomcp.session.last_completed_outcome'],
    ).toBeUndefined();

    // Nothing has completed yet.
    const second = t.beginQuery(20);
    expect(second.attributes['kustomcp.query.retry_class']).toBe(
      'after_in_flight',
    );
    expect(second.attributes['kustomcp.session.last_completed_outcome']).toBe(
      'none',
    );

    // `first` finishes (out of order) while `second` is still running.
    first.finish({ status: 'error', failureCategory: 'timeout' });
    const third = t.beginQuery(20);
    expect(third.attributes['kustomcp.query.retry_class']).toBe(
      'after_in_flight',
    );
    expect(third.attributes['kustomcp.session.last_completed_outcome']).toBe(
      'timeout',
    );

    second.finish({ status: 'ok', rowCount: 0 });
    const fourth = t.beginQuery(20);
    expect(fourth.attributes['kustomcp.session.last_completed_outcome']).toBe(
      'empty',
    );
    third.finish({ status: 'ok', rowCount: 1 });
    fourth.finish({ status: 'ok', rowCount: 1 });

    const fifth = t.beginQuery(20).attributes;
    expect(fifth['kustomcp.query.retry_class']).toBe('after_success');
    expect(fifth['kustomcp.session.last_completed_outcome']).toBeUndefined();
    for (const a of [second, third, fourth]) {
      expect(LAST_COMPLETED_OUTCOMES).toContain(
        a.attributes['kustomcp.session.last_completed_outcome'],
      );
    }
  });

  test('failureStreakBucket', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 100].map(failureStreakBucket)).toEqual([
      '0',
      '1',
      '2',
      '3-4',
      '3-4',
      '5+',
      '5+',
      '5+',
    ]);
  });
});
