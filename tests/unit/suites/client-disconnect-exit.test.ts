/**
 * Client-disconnect exits are not crashes (#365).
 *
 * When the MCP client goes away, the server's next response write to stdout
 * fails with EPIPE and the process exits through `uncaughtException`. That
 * used to be counted in `kustomcp.process.fatal` like a real crash, and it
 * made up almost every fatal exit. The disconnect is now an INFO log and
 * stays out of the counter; every other fatal error is reported as before.
 *
 * The test is identity, not shape: only the error object stdout itself
 * emitted counts as a disconnect. An EPIPE with the same code and syscall
 * from anywhere else is still a crash.
 */

import { EventEmitter, errorMonitor } from 'node:events';
import {
  recordProcessFatal,
  watchStdoutForDisconnect,
} from '../../../src/common/telemetry.js';

type Attrs = Record<string, unknown> | undefined;
type Added = { value: number; attributes: Attrs };
type Logged = { severity: string; message: string; attributes: Attrs };
type WatchableStream = Pick<NodeJS.WriteStream, 'on'>;

// Factories must not close over test-file variables, so each mock owns its
// sink and exposes it on the mocked module.
jest.mock('@opentelemetry/api', () => {
  const actual = jest.requireActual('@opentelemetry/api');
  const sink: Added[] = [];
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
  const sink: Logged[] = [];
  return {
    ...actual,
    __logged: sink,
    logs: {
      getLogger: () => ({
        emit: (r: { severityText: string; body: string; attributes: Attrs }) =>
          sink.push({
            severity: r.severityText,
            message: r.body,
            attributes: r.attributes,
          }),
      }),
    },
  };
});

const added = (jest.requireMock('@opentelemetry/api') as { __added: Added[] })
  .__added;
const logged = (
  jest.requireMock('@opentelemetry/api-logs') as { __logged: Logged[] }
).__logged;

function errnoError(
  code: string,
  message = `write ${code}`,
): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(message);
  err.code = code;
  err.syscall = 'write';
  return err;
}

/**
 * A stand-in for process.stdout whose write just failed with `err`. Watching
 * must not handle the error: it still throws, which is how the real failure
 * reaches `uncaughtException`. (Jest's sandbox makes EventEmitter wrap the
 * error, so this checks that it throws, not what.)
 */
function failingStdout(err: Error): EventEmitter {
  const stdout = new EventEmitter();
  watchStdoutForDisconnect(stdout as unknown as WatchableStream);
  expect(() => stdout.emit('error', err)).toThrow();
  return stdout;
}

describe('client-disconnect exit telemetry', () => {
  beforeEach(() => {
    added.length = 0;
    logged.length = 0;
  });

  it('logs the EPIPE stdout emitted as a client disconnect at INFO', () => {
    const err = errnoError('EPIPE');
    failingStdout(err);

    recordProcessFatal('uncaughtException', err);

    expect(logged).toEqual([
      {
        severity: 'INFO',
        message: 'Client disconnected; exiting',
        attributes: {
          'kustomcp.fatal.kind': 'uncaughtException',
          'kustomcp.error.type': 'Error',
          'kustomcp.error.code': 'EPIPE',
          'kustomcp.exit.reason': 'client_disconnected',
        },
      },
    ]);
  });

  it('leaves a client disconnect out of kustomcp.process.fatal', () => {
    const err = errnoError('EPIPE');
    failingStdout(err);

    recordProcessFatal('uncaughtException', err);

    expect(added).toHaveLength(0);
  });

  it('still counts an EPIPE that stdout did not emit', () => {
    failingStdout(errnoError('EPIPE'));
    const elsewhere = errnoError('EPIPE');

    recordProcessFatal('uncaughtException', elsewhere);

    expect(added).toHaveLength(1);
    expect(added[0].attributes).toMatchObject({
      'kustomcp.error.code': 'EPIPE',
    });
    expect(added[0].attributes?.['kustomcp.exit.reason']).toBeUndefined();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      severity: 'ERROR',
      message: 'Process terminating on fatal error',
    });
  });

  it('still counts a stdout error that is not EPIPE', () => {
    const err = errnoError('ECONNRESET');
    failingStdout(err);

    recordProcessFatal('uncaughtException', err);

    expect(added).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      severity: 'ERROR',
      message: 'Process terminating on fatal error',
    });
  });

  it('reports any other fatal error exactly as before', () => {
    failingStdout(errnoError('EPIPE'));

    recordProcessFatal('unhandledRejection', new TypeError('boom'));

    expect(added).toEqual([
      {
        value: 1,
        attributes: {
          'kustomcp.fatal.kind': 'unhandledRejection',
          'kustomcp.error.type': 'TypeError',
        },
      },
    ]);
    expect(logged).toEqual([
      {
        severity: 'ERROR',
        message: 'Process terminating on fatal error',
        attributes: {
          'kustomcp.fatal.kind': 'unhandledRejection',
          'kustomcp.error.type': 'TypeError',
        },
      },
    ]);
  });

  it('never emits the error message on the disconnect path', () => {
    const err = errnoError('EPIPE', 'cluster=secret.kusto.windows.net');
    failingStdout(err);

    recordProcessFatal('uncaughtException', err);

    const serialized = JSON.stringify({ added, logged });
    expect(serialized).not.toContain('secret.kusto.windows.net');
    expect(serialized).not.toContain('at Object');
  });

  it('never throws when the stream cannot be watched', () => {
    const broken = {
      on: () => {
        throw new Error('no listeners here');
      },
    };

    expect(() =>
      watchStdoutForDisconnect(broken as unknown as WatchableStream),
    ).not.toThrow();
  });

  it('watches process.stdout through errorMonitor by default', () => {
    // mockImplementation so the assertion does not leave a real listener behind
    const on = jest
      .spyOn(process.stdout, 'on')
      .mockImplementation(() => process.stdout);

    watchStdoutForDisconnect();

    // errorMonitor, not 'error': an 'error' listener would swallow the EPIPE
    // and change how the process exits.
    expect(on).toHaveBeenCalledWith(errorMonitor, expect.any(Function));
    expect(on).not.toHaveBeenCalledWith('error', expect.any(Function));
    on.mockRestore();
  });
});
