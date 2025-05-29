/**
 * Safe logging function that won't interfere with MCP protocol
 *
 * @param message The message to log
 */
export function safeLog(message: string): void {
  if (process.env.DEBUG_SERVER === '1') {
    process.stderr.write(`${message}\n`);
  }
}
