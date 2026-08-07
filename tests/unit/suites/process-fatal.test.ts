/**
 * Process-fatal telemetry (#180, #196 follow-up).
 *
 * The orphan spin ran on thousands of machines and produced zero telemetry:
 * the crash handlers wrote only to stderr, and the spin starved the exporters.
 * `recordProcessFatal` makes that class of failure countable.
 *
 * Two properties matter more than the happy path, and both are pinned here:
 * it must not leak error messages or stacks, and it must not throw — it runs
 * on the crash path, where a second failure is what caused the loop.
 */

import { recordProcessFatal } from '../../../src/common/telemetry.js';

type Attrs = Record<string, unknown> | undefined;
type Recorded = { value?: number; message?: string; attributes?: Attrs };

// Factories must not close over test-file variables, so each mock owns its
// sink and exposes it on the mocked module.
jest.mock('@opentelemetry/api', () => {
  const actual = jest.requireActual('@opentelemetry/api');
  const sink: Recorded[] = [];
  return {
    ...actual,
    __added: sink,
    trace: { ...actual.trace, getActiveSpan: () => undefined },
    metrics: {
      getMeter: () => ({
        createCounter: () => ({
          add: (value: number, attributes: Attrs) =>
            sink.push({ value, attributes }),
        }),
        createHistogram: () => ({ record: () => {} }),
      }),
    },
  };
});

jest.mock('@opentelemetry/api-logs', () => {
  const actual = jest.requireActual('@opentelemetry/api-logs');
  const sink: Recorded[] = [];
  return {
    ...actual,
    __logged: sink,
    logs: {
      getLogger: () => ({
        emit: (r: { body: string; attributes: Attrs }) =>
          sink.push({ message: r.body, attributes: r.attributes }),
      }),
    },
  };
});

const addedSink = (
  jest.requireMock('@opentelemetry/api') as { __added: Recorded[] }
).__added;
const loggedSink = (
  jest.requireMock('@opentelemetry/api-logs') as { __logged: Recorded[] }
).__logged;

describe('recordProcessFatal', () => {
  beforeEach(() => {
    addedSink.length = 0;
    loggedSink.length = 0;
  });

  it('counts the failure with its kind and error class', () => {
    recordProcessFatal('uncaughtException', new TypeError('boom'));

    expect(addedSink).toHaveLength(1);
    expect(addedSink[0].value).toBe(1);
    expect(addedSink[0].attributes).toMatchObject({
      'kustomcp.fatal.kind': 'uncaughtException',
      'kustomcp.error.type': 'TypeError',
    });
  });

  it('captures the errno code, which is what identifies a broken pipe', () => {
    const err: NodeJS.ErrnoException = new Error('write EPIPE');
    err.code = 'EPIPE';

    recordProcessFatal('uncaughtException', err);

    expect(addedSink[0].attributes).toMatchObject({
      'kustomcp.error.code': 'EPIPE',
    });
  });

  it('omits the code attribute when there is none', () => {
    recordProcessFatal('unhandledRejection', new Error('plain'));

    expect(addedSink[0].attributes).not.toHaveProperty('kustomcp.error.code');
  });

  it('never emits the error message or stack', () => {
    const err = new Error('cluster=secret.kusto.windows.net user=alice@corp');

    recordProcessFatal('uncaughtException', err);

    const serialized = JSON.stringify({ addedSink, loggedSink });
    expect(serialized).not.toContain('secret.kusto.windows.net');
    expect(serialized).not.toContain('alice@corp');
    expect(serialized).not.toContain('at Object');
  });

  it('emits an ERROR log alongside the counter', () => {
    recordProcessFatal('unhandledRejection', new RangeError('nope'));

    expect(loggedSink).toHaveLength(1);
    expect(loggedSink[0].message).toBe('Process terminating on fatal error');
    expect(loggedSink[0].attributes).toMatchObject({
      'kustomcp.fatal.kind': 'unhandledRejection',
      'kustomcp.error.type': 'RangeError',
    });
  });

  it('tolerates non-Error rejection values', () => {
    expect(() =>
      recordProcessFatal('unhandledRejection', 'a string'),
    ).not.toThrow();
    expect(() =>
      recordProcessFatal('unhandledRejection', undefined),
    ).not.toThrow();
    expect(addedSink[0].attributes).toMatchObject({
      'kustomcp.error.type': 'Error',
    });
  });
});
