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

/**
 * @deprecated Use criticalLog() or debugLog() instead
 * Safe logging function that won't interfere with MCP protocol
 *
 * @param message The message to log
 */
export function safeLog(message: string): void {
  if (process.env.DEBUG_SERVER === '1') {
    process.stderr.write(`${message}\n`);
  }
}
