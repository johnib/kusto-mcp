/**
 * Kill bound for credential subprocesses, given the connect deadline: 1s
 * before it, so a hung `az` fails as an az timeout (with its own hint)
 * instead of as a bare connect timeout. At least 5s, so a short deadline
 * doesn't kill a normal az run; the deadline's abort still stops it.
 */
export function credentialProcessTimeout(connectTimeoutMs: number): number {
  return Math.max(5000, connectTimeoutMs - 1000);
}

/**
 * GetTokenOptions key: a kill bound for this request's `az` run, from what is
 * left of the connect deadline. The fixed bound above starts when az spawns,
 * after the cloud-metadata step, so on its own a slow metadata step lets the
 * deadline fire first. az uses the shorter of the two.
 */
export const AZ_TIMEOUT_MS = 'kustoMcpAzTimeoutMs';

/**
 * The per-request az bound: always before the deadline — 1s of headroom, or
 * half of what is left when that is under 2s (at least 100ms).
 */
export function azTimeoutFromRemaining(remainingMs: number): number {
  const remaining = Math.floor(remainingMs);
  return Math.max(100, remaining - Math.min(1000, Math.floor(remaining / 2)));
}
