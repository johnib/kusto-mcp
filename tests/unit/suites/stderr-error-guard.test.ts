/**
 * Orphaned-server CPU spin (#180, #196).
 *
 * When the MCP client dies, the next write to stderr fails with EPIPE. Node
 * surfaces that as an 'error' event, and an 'error' event with no listener is
 * re-raised as an uncaught exception — which the uncaughtException handler
 * reports through stderr, raising EPIPE again. Servers were found orphaned for
 * days at ~100% CPU, stuck in that loop.
 *
 * These tests pin the guard that breaks the cycle.
 */

import { EventEmitter } from 'node:events';
import { installStderrErrorGuard } from '../../../src/common/utils.js';

/** The EPIPE a dead client produces on the next write. */
function epipe(): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error('write EPIPE');
  error.code = 'EPIPE';
  return error;
}

type GuardableStream = Pick<NodeJS.WriteStream, 'on'>;

describe('installStderrErrorGuard', () => {
  it('an unguarded stream re-raises EPIPE as an unhandled error', () => {
    const stderr = new EventEmitter();

    // This is the mechanism the spin is built on: Node throws when an 'error'
    // event has no listener, which is how EPIPE became an uncaughtException.
    expect(() => stderr.emit('error', epipe())).toThrow('write EPIPE');
  });

  it('swallows EPIPE on the guarded stream instead of re-raising it', () => {
    const stderr = new EventEmitter();

    installStderrErrorGuard(stderr as unknown as GuardableStream);

    expect(() => stderr.emit('error', epipe())).not.toThrow();
  });

  it('stays quiet across repeated failures, so the handler cannot loop', () => {
    const stderr = new EventEmitter();

    installStderrErrorGuard(stderr as unknown as GuardableStream);

    // The loop only spins because every retry raises again. Each write the
    // uncaughtException handler attempts must stay silent, not just the first.
    for (let attempt = 0; attempt < 5; attempt++) {
      expect(() => stderr.emit('error', epipe())).not.toThrow();
    }
  });

  it('defaults to process.stderr when no stream is given', () => {
    // mockImplementation so the assertion does not leave a real listener behind
    const on = jest
      .spyOn(process.stderr, 'on')
      .mockImplementation(() => process.stderr);

    installStderrErrorGuard();

    expect(on).toHaveBeenCalledWith('error', expect.any(Function));
    on.mockRestore();
  });
});
