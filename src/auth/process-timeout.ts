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
 * GetTokenOptions key: the connect deadline as an epoch-ms timestamp. `az`
 * turns it into a kill bound when it actually spawns — after the metadata
 * step and any earlier chain steps — so a hung az fails as an az timeout
 * just before the deadline instead of being cut off by it.
 */
export const AZ_DEADLINE_AT = 'kustoMcpAzDeadlineAt';

/**
 * Kill bound for an az run starting now, given the deadline: 1s before it,
 * or half of what is left when that is under 2s; at least 100ms.
 */
export function azTimeoutUntil(deadlineAt: number, now = Date.now()): number {
  const left = Math.floor(deadlineAt - now);
  return Math.max(100, left - Math.min(1000, Math.floor(left / 2)));
}
