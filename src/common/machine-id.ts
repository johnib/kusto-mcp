import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { debugLog } from './utils.js';

/**
 * Persistent, purely-random install identifier. Lets telemetry count distinct
 * installs and adoption over time WITHOUT folding in any host/user data (so the
 * id itself leaks nothing). Stored at:
 *   - Windows: %LOCALAPPDATA%\kusto-mcp\machine_id
 *   - other:   $XDG_DATA_HOME/kusto-mcp/machine_id  (default ~/.local/share/...)
 * Delete the file to reset the id.
 *
 * The file holds JSON: { machineId, firstSeen (date-floored), hasConnected }.
 * A legacy file (a bare UUID string from older versions) is still read; its
 * firstSeen is derived from the file's birthtime, floored to the day.
 */

function machineIdDir(): string {
  if (process.platform === 'win32') {
    const base =
      process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(base, 'kusto-mcp');
  }
  const xdg = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(xdg, 'kusto-mcp');
}

function machineIdFile(): string {
  return join(machineIdDir(), 'machine_id');
}

export interface MachineIdentity {
  machineId: string;
  firstSeen: string; // YYYY-MM-DD (date-floored — no ms-precision fingerprint)
  hasConnected: boolean; // has this install ever completed a connection?
  isFirstRun: boolean;
}

interface StoredIdentity {
  machineId: string;
  firstSeen: string;
  hasConnected: boolean;
}

/** Parse the store, tolerating both the JSON format and a legacy bare UUID. */
function readStored(file: string): StoredIdentity | null {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8').trim();
  } catch (error) {
    debugLog(`machine_id read failed: ${String(error)}`);
    return null;
  }
  if (!raw) return null;

  if (raw.startsWith('{')) {
    try {
      const obj = JSON.parse(raw) as Partial<StoredIdentity>;
      if (obj.machineId) {
        return {
          machineId: obj.machineId,
          firstSeen: obj.firstSeen || new Date().toISOString().slice(0, 10),
          hasConnected: !!obj.hasConnected,
        };
      }
    } catch {
      /* fall through to treat as legacy/corrupt */
    }
    return null;
  }

  // Legacy bare-UUID file: derive firstSeen from birthtime (date only).
  let firstSeen = new Date().toISOString().slice(0, 10);
  try {
    firstSeen = statSync(file).birthtime.toISOString().slice(0, 10);
  } catch {
    /* birthtime unavailable on some filesystems */
  }
  return { machineId: raw, firstSeen, hasConnected: false };
}

function writeStored(file: string, value: StoredIdentity): void {
  try {
    mkdirSync(machineIdDir(), { recursive: true });
    writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  } catch (error) {
    debugLog(`machine_id write failed: ${String(error)}`);
  }
}

export function loadOrCreateMachineId(): MachineIdentity {
  const file = machineIdFile();
  if (existsSync(file)) {
    const stored = readStored(file);
    if (stored) {
      return { ...stored, isFirstRun: false };
    }
  }

  const created: StoredIdentity = {
    machineId: randomUUID(),
    firstSeen: new Date().toISOString().slice(0, 10),
    hasConnected: false,
  };
  writeStored(file, created);
  return { ...created, isFirstRun: true };
}

// Avoid re-touching the file more than once per process.
let markedThisProcess = false;

/**
 * Record that this install has completed a connection at least once. Returns
 * true only the FIRST time it flips (per install) — i.e. the install's very
 * first successful connection. Best-effort; never throws.
 */
export function markConnected(): boolean {
  if (markedThisProcess) return false;
  markedThisProcess = true;
  const file = machineIdFile();
  const stored = readStored(file);
  if (!stored) return false; // no id yet (shouldn't happen post-startup)
  if (stored.hasConnected) return false;
  writeStored(file, { ...stored, hasConnected: true });
  return true;
}
