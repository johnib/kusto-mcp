import type { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

/**
 * The stdin end-of-stream signals that indicate the MCP client has gone away.
 *
 * A stdio MCP server's lifetime is bound to its client: once the client closes
 * the pipe the server must exit, otherwise it lingers as an orphan. There are two
 * distinct ways the pipe can go away and BOTH must trigger shutdown:
 *
 *   - a *clean* close — the client ends the stream: `'end'` / `'close'`.
 *   - an *abrupt* teardown — the client (or an intermediate wrapper such as an
 *     `npx`/`cmd.exe` launcher) is killed and the pipe breaks. On Windows this
 *     commonly surfaces as an `'error'` on stdin rather than a graceful `'end'`.
 *
 * The `'error'` arm is the important one: without it, an abrupt disconnect leaves
 * the `'end'`/`'close'` handlers un-fired, so the server keeps running long after
 * its client is gone (observed in the wild as orphaned, CPU-burning processes).
 */
export interface StdioLifecycleDeps {
  /** The active transport; its `onclose` is wired to the same shutdown path. */
  transport: Pick<StdioServerTransport, 'onclose'>;
  /** Process stdin (or any EventEmitter exposing `once`). */
  stdin: Pick<NodeJS.ReadStream, 'once'>;
  /** Invoked once when the client disconnects, by any of the signals above. */
  onDisconnect: () => void;
}

/**
 * Wire every client-disconnect signal to `onDisconnect`. The callback is expected
 * to be idempotent (guarded against re-entry) because more than one of these
 * events can fire for a single disconnect.
 */
export function installStdioLifecycle({
  transport,
  stdin,
  onDisconnect,
}: StdioLifecycleDeps): void {
  transport.onclose = onDisconnect;
  stdin.once('end', onDisconnect);
  stdin.once('close', onDisconnect);
  // Abrupt broken-pipe teardown (e.g. the client process is killed on Windows)
  // arrives as an 'error', not a clean 'end'. Attaching a listener both routes it
  // to shutdown AND prevents the unhandled-'error' path.
  stdin.once('error', onDisconnect);
}
