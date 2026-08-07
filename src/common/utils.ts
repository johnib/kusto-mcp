/**
 * Critical logging function that always prints important messages
 * Use for startup, shutdown, errors, and configuration messages
 *
 * @param message The message to log
 */
export function criticalLog(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * Stop a dead stderr from turning every log line into a new crash.
 *
 * When the MCP client goes away, the next write to stderr fails with EPIPE.
 * Node reports that asynchronously as an 'error' event, and an 'error' event
 * with no listener is re-raised as an uncaught exception. The process-level
 * uncaughtException handler then reports the failure through stderr — the very
 * stream that just failed — which raises EPIPE again. The server spins in that
 * loop at ~100% CPU instead of exiting, and stdin's EOF callback never gets to
 * run because the loop starves the event loop.
 *
 * Attaching a listener is what breaks the cycle; it is intentionally empty,
 * because once stderr is gone there is nowhere left to report to.
 *
 * @param stderr The stderr stream to guard
 */
export function installStderrErrorGuard(
  stderr: Pick<NodeJS.WriteStream, 'on'> = process.stderr,
): void {
  stderr.on('error', () => {});
}

/**
 * Debug logging function that only prints when DEBUG_SERVER=1
 * Use for detailed debugging information
 *
 * @param message The message to log
 */
export function debugLog(message: string): void {
  if (process.env.DEBUG_SERVER === '1') {
    process.stderr.write(`${message}\n`);
  }
}
