import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
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
 * Streaks are kept per config, keyed by a local hash of cluster URL +
 * database + auth method, so a host that alternates configs backs off for
 * each of them and a success clears only its own config (#441). Nothing here
 * is sent to telemetry.
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

// Bounds the number of configs kept; the most recently attempted win.
const MAX_KEYS_KEPT = 16;

// key -> start times (epoch ms) of attempts without a success.
type BackoffState = Map<string, number[]>;

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

function isAttemptList(v: unknown): v is number[] {
  return Array.isArray(v) && v.every(t => Number.isFinite(t));
}

/**
 * Read the state file. Accepts the current `{ keys: { [key]: number[] } }`
 * form and the single-record `{ key, attempts }` form written before #441.
 * Missing or corrupt files (or entries) mean no backoff.
 */
function readState(): BackoffState {
  const state: BackoffState = new Map();
  try {
    const obj = JSON.parse(readFileSync(backoffFile(), 'utf8')) as unknown;
    if (typeof obj !== 'object' || obj === null) return state;
    const { keys, key, attempts } = obj as Record<string, unknown>;
    if (typeof keys === 'object' && keys !== null && !Array.isArray(keys)) {
      for (const [k, v] of Object.entries(keys)) {
        if (isAttemptList(v)) state.set(k, v);
      }
    } else if (typeof key === 'string' && isAttemptList(attempts)) {
      state.set(key, attempts);
    }
  } catch {
    /* missing or corrupt: no backoff */
  }
  return state;
}

function writeState(state: BackoffState): void {
  mkdirSync(stateDir(), { recursive: true });
  const data = { keys: Object.fromEntries(state) };
  // Write a temp file and rename it over the real one, so a launch that
  // starts at the same time never reads a half-written file and drops the
  // streaks of other configs.
  const file = backoffFile();
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (error) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best effort */
    }
    throw error;
  }
}

/**
 * Keep only attempts inside the window for every config, and drop configs
 * left with none. Timestamps in the future (clock went backwards) are dropped
 * too.
 */
function pruneState(state: BackoffState, now: number): BackoffState {
  const pruned: BackoffState = new Map();
  for (const [k, list] of state) {
    const recent = list.filter(t => t <= now && now - t <= WINDOW_MS);
    if (recent.length > 0) pruned.set(k, recent);
  }
  return pruned;
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
    // Only this config's attempts count, so configs that alternate on the
    // same host keep separate streaks (#441).
    const state = pruneState(readState(), now);
    const recent = state.get(key) ?? [];
    if (recent.length > 0) {
      const wait = cooldownMs(recent.length) - (now - Math.max(...recent));
      if (wait > 0) return { skip: true, retryInMs: wait };
    }
    state.delete(key);
    state.set(key, [...recent, now].slice(-MAX_ATTEMPTS_KEPT));
    if (state.size > MAX_KEYS_KEPT) {
      // Keep the configs attempted most recently; this one has `now`, the
      // latest time in the pruned state, so it is always kept.
      const newest = [...state.entries()]
        .sort((a, b) => Math.max(...b[1]) - Math.max(...a[1]))
        .slice(0, MAX_KEYS_KEPT);
      writeState(new Map(newest));
    } else {
      writeState(state);
    }
  } catch (error) {
    debugLog(`autoconnect backoff write failed: ${String(error)}`);
  }
  return { skip: false, retryInMs: 0 };
}

/**
 * A connection for this config succeeded: drop its failure streak only, so a
 * working config does not clear the streak of a broken one (#441).
 * Never throws.
 */
export function clearAutoConnectBackoff(key: string): void {
  try {
    const state = readState();
    if (!state.delete(key)) return;
    if (state.size === 0) {
      const file = backoffFile();
      if (existsSync(file)) unlinkSync(file);
    } else {
      writeState(state);
    }
  } catch (error) {
    debugLog(`autoconnect backoff clear failed: ${String(error)}`);
  }
}
