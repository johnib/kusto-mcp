/**
 * Kill bound for credential subprocesses, given the connect deadline: 1s
 * before it, so a hung `az` fails as an az timeout (with its own hint)
 * instead of as a bare connect timeout. At least 5s, so a short deadline
 * doesn't kill a normal az run; the deadline's abort still stops it.
 */
export function credentialProcessTimeout(connectTimeoutMs: number): number {
  return Math.max(5000, connectTimeoutMs - 1000);
}
