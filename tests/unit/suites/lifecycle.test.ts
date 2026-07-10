/**
 * Stdio lifecycle wiring: every client-disconnect signal — a clean end/close AND
 * an abrupt broken-pipe 'error' — must route to the shutdown callback exactly the
 * same way, so the server can never be left running after its client is gone.
 */

import { EventEmitter } from 'node:events';
import { installStdioLifecycle } from '../../../src/common/lifecycle.js';

type Stdin = Pick<NodeJS.ReadStream, 'once'>;

function wire() {
  const stdin = new EventEmitter() as unknown as Stdin & EventEmitter;
  const transport: { onclose?: () => void } = {};
  const onDisconnect = jest.fn();
  installStdioLifecycle({
    transport: transport as never,
    stdin,
    onDisconnect,
  });
  return { stdin, transport, onDisconnect };
}

describe('installStdioLifecycle', () => {
  it('wires transport.onclose to the disconnect handler', () => {
    const { transport, onDisconnect } = wire();
    expect(transport.onclose).toBe(onDisconnect);
  });

  it.each(['end', 'close', 'error'] as const)(
    "shuts down on stdin '%s'",
    signal => {
      const { stdin, onDisconnect } = wire();
      (stdin as unknown as EventEmitter).emit(signal, new Error('broken pipe'));
      expect(onDisconnect).toHaveBeenCalledTimes(1);
    },
  );

  it("routes an abrupt stdin 'error' to shutdown (regression: broken-pipe orphan)", () => {
    // The pre-fix code listened only for 'end'/'close'. A killed client on Windows
    // breaks the pipe as an 'error', which previously left the server running.
    const { stdin, onDisconnect } = wire();
    (stdin as unknown as EventEmitter).emit('error', new Error('EPIPE'));
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });
});
