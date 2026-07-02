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

export interface MachineIdentity {
  machineId: string;
  firstSeen: string; // ISO date of the install
  isFirstRun: boolean;
}

export function loadOrCreateMachineId(): MachineIdentity {
  const file = join(machineIdDir(), 'machine_id');
  try {
    if (existsSync(file)) {
      const machineId = readFileSync(file, 'utf8').trim();
      if (machineId) {
        let firstSeen = new Date().toISOString();
        try {
          firstSeen = statSync(file).birthtime.toISOString();
        } catch {
          /* birthtime unavailable on some filesystems */
        }
        return { machineId, firstSeen, isFirstRun: false };
      }
    }
  } catch (error) {
    debugLog(`machine_id read failed: ${String(error)}`);
  }

  const machineId = randomUUID();
  try {
    mkdirSync(machineIdDir(), { recursive: true });
    writeFileSync(file, `${machineId}\n`, { mode: 0o600 });
  } catch (error) {
    debugLog(`machine_id write failed: ${String(error)}`);
  }
  return { machineId, firstSeen: new Date().toISOString(), isFirstRun: true };
}
