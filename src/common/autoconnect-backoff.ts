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
 * Once THRESHOLD attempts without a success fall within the last hour, startup
 * auto-connect is skipped for a capped cooldown that doubles with each further
 * recent attempt. Manual initialize-connection is never gated.
 *
 * The record is keyed by a local hash of cluster URL + database + auth method,
 * so changing the config starts fresh. Nothing here is sent to telemetry.
 * Every fs access is best-effort: a missing, corrupt or unwritable file just
 * means no backoff.
 */

export const BACKOFF_THRESHOLD = 3;
const BASE_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 10 * 60_000;
// Rolling window: attempts older than this no longer count.
const WINDOW_MS = 60 * 60_000;
// Bounds the file; enough to reach the max cooldown.
const MAX_ATTEMPTS_KEPT = 20;

interface BackoffRecord {
  key: string;
  attempts: number[]; // start times (epoch ms) of attempts without a success
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

/** Cooldown after `failures` recent failed attempts: 0, then 30s → 10 min. */
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
      Array.isArray(r.attempts) &&
      r.attempts.every(t => Number.isFinite(t))
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
    // Only this config's attempts inside the window count. Timestamps in the
    // future (clock went backwards) are dropped too.
    const recent =
      rec && rec.key === key
        ? rec.attempts.filter(t => t <= now && now - t <= WINDOW_MS)
        : [];
    if (recent.length > 0) {
      const wait = cooldownMs(recent.length) - (now - Math.max(...recent));
      if (wait > 0) return { skip: true, retryInMs: wait };
    }
    const next: BackoffRecord = {
      key,
      attempts: [...recent, now].slice(-MAX_ATTEMPTS_KEPT),
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
