import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './machine-id.js';
import { debugLog } from './utils.js';

/**
 * Cross-launch backoff for the startup auto-connect (#316).
 *
 * Some hosts relaunch the server over and over when it can't connect. Each
 * launch is a new process, so an in-memory backoff can't help: the state lives
 * in a tiny file next to machine_id. Every startup attempt is counted before it
 * starts (so a launch killed mid-connect still counts) and a success clears it.
 * After THRESHOLD attempts in a row without a success, startup auto-connect is
 * skipped for a capped, doubling cooldown. Manual initialize-connection is
 * never gated.
 *
 * The record is keyed by a local hash of cluster URL + database + auth method,
 * so changing the config starts fresh. Nothing here is sent to telemetry.
 * Every fs access is best-effort: a missing, corrupt or unwritable file just
 * means no backoff.
 */

export const BACKOFF_THRESHOLD = 3;
const BASE_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 10 * 60_000;
// Attempts older than this no longer count toward the streak.
const STALE_AFTER_MS = 60 * 60_000;

interface BackoffRecord {
  key: string;
  failures: number;
  lastAttempt: number;
}

export interface BackoffDecision {
  skip: boolean;
  retryInMs: number;
}

function backoffFile(): string {
  return join(stateDir(), 'autoconnect_backoff');
}

export function autoConnectKey(
  clusterUrl: string,
  database: string,
  authMethod: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify([clusterUrl, database, authMethod]))
    .digest('hex')
    .slice(0, 32);
}

/** Cooldown after `failures` consecutive failed attempts: 0, then 30s → 10 min. */
export function cooldownMs(failures: number): number {
  if (failures < BACKOFF_THRESHOLD) return 0;
  return Math.min(
    BASE_COOLDOWN_MS * 2 ** (failures - BACKOFF_THRESHOLD),
    MAX_COOLDOWN_MS,
  );
}

function readRecord(): BackoffRecord | null {
  try {
    const obj = JSON.parse(readFileSync(backoffFile(), 'utf8')) as unknown;
    const r = obj as Partial<BackoffRecord>;
    if (
      typeof r?.key === 'string' &&
      Number.isInteger(r.failures) &&
      (r.failures as number) >= 0 &&
      Number.isFinite(r.lastAttempt)
    ) {
      return r as BackoffRecord;
    }
  } catch {
    /* missing or corrupt: no backoff */
  }
  return null;
}

/**
 * Decide whether this launch's startup auto-connect should run. When it
 * should, the attempt is recorded up front (cleared again on success).
 * Never throws.
 */
export function beginAutoConnect(
  key: string,
  now = Date.now(),
): BackoffDecision {
  try {
    const rec = readRecord();
    let failures = 0;
    if (rec && rec.key === key) {
      const elapsed = now - rec.lastAttempt;
      // A clock that went backwards or an old streak starts fresh.
      if (elapsed >= 0 && elapsed <= STALE_AFTER_MS) {
        const wait = cooldownMs(rec.failures) - elapsed;
        if (wait > 0) return { skip: true, retryInMs: wait };
        failures = rec.failures;
      }
    }
    const next: BackoffRecord = {
      key,
      failures: Math.min(failures + 1, 1000),
      lastAttempt: now,
    };
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(backoffFile(), `${JSON.stringify(next)}\n`, { mode: 0o600 });
  } catch (error) {
    debugLog(`autoconnect backoff write failed: ${String(error)}`);
  }
  return { skip: false, retryInMs: 0 };
}

/** A connection succeeded: drop the failure streak. Never throws. */
export function clearAutoConnectBackoff(): void {
  try {
    const file = backoffFile();
    if (existsSync(file)) unlinkSync(file);
  } catch (error) {
    debugLog(`autoconnect backoff clear failed: ${String(error)}`);
  }
}
