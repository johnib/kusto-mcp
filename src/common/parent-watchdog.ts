import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { criticalLog, debugLog } from './utils.js';

const execFileAsync = promisify(execFile);

/**
 * Windows-safe orphan detection for the stdio transport.
 *
 * The server is designed to exit when the MCP client closes stdin (see
 * index.ts). That works on POSIX, but on Windows clients typically launch the
 * server through intermediary processes — e.g. `cmd /c npx -y kusto-mcp@latest`,
 * which itself spawns another `cmd` and `node`. Those intermediaries inherit the
 * write end of the server's stdin and keep it open, so when the *client* dies
 * the pipe is never closed: stdin never reaches EOF, `'end'`/`'close'` never
 * fire, and the entire subtree is orphaned. The stranded server then sits on a
 * half-dead pipe consuming CPU indefinitely.
 *
 * `process.ppid` cannot detect this because the *direct* parent (an intermediary
 * cmd/node) stays alive. Instead we snapshot the full ancestor PID chain once at
 * startup and periodically verify every ancestor still exists; the moment any
 * link dies — which is what happens when the client/editor exits — we trigger a
 * clean shutdown, releasing the wedged intermediaries with us.
 *
 * This is a best-effort *backstop* to the stdin-EOF handlers, not a replacement:
 *   - It only arms on Windows (POSIX stdin EOF is reliable), and any failure to
 *     read the process table simply disables it — it never blocks startup.
 *   - Liveness is keyed on PID alone against the startup snapshot, so two edge
 *     cases are accepted by design: (a) false negative — if a dead ancestor's
 *     PID is reused within the poll window it reads as alive and the orphan
 *     lingers (degrading to the pre-fix behaviour, no worse); (b) false positive
 *     — the chain is walked to the OS root and any dead ancestor triggers
 *     shutdown, so force-killing a grandparent (e.g. the editor host) while the
 *     client survives also stops the server. The client PID cannot be identified
 *     from the chain alone; `KUSTO_ENABLE_PARENT_WATCHDOG=false` is the opt-out.
 *
 * The runtime cost is one `process.kill(pid, 0)` per ancestor once a minute.
 */

const DEFAULT_INTERVAL_MS = 60_000;
const MIN_INTERVAL_MS = 1_000;
// Enumerating every process yields a large payload on busy hosts; give execFile
// generous headroom so the snapshot is never truncated into a parse failure.
const MAX_TABLE_BYTES = 16 * 1024 * 1024;

/**
 * Walk the pid->ppid map from `startPid` up to the root, returning the ancestor
 * PIDs (excluding `startPid` itself). Safe against missing links, non-positive
 * roots, and cycles.
 */
export function computeAncestors(
  startPid: number,
  parentOf: ReadonlyMap<number, number>,
): number[] {
  const ancestors: number[] = [];
  const seen = new Set<number>([startPid]);
  let current = parentOf.get(startPid);
  while (
    current !== undefined &&
    current > 0 &&
    current !== startPid &&
    !seen.has(current)
  ) {
    ancestors.push(current);
    seen.add(current);
    current = parentOf.get(current);
  }
  return ancestors;
}

/**
 * Parse whitespace-separated "pid ppid" lines into a pid->ppid map. Both `ps`
 * and the Windows CIM query below emit this shape; non-numeric lines (headers,
 * blanks) are ignored.
 */
export function parseProcessTable(output: string): Map<number, number> {
  const map = new Map<number, number>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (match) {
      map.set(Number(match[1]), Number(match[2]));
    }
  }
  return map;
}

async function readProcessTable(): Promise<Map<number, number>> {
  if (process.platform === 'win32') {
    // Resolve powershell.exe by ABSOLUTE path. A bare "powershell.exe" is
    // resolved by libuv starting at the current working directory, which for an
    // MCP server is often an untrusted workspace — a malicious powershell.exe
    // dropped there would be executed at startup. An absolute path skips that
    // search entirely (and falls safe: if absent, the read fails and the
    // watchdog simply disables).
    const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    const powershell = `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    // One-shot CIM query -> "pid ppid" per line. Avoids the deprecated `wmic`.
    const { stdout } = await execFileAsync(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
      ],
      { encoding: 'utf8', timeout: 5_000, windowsHide: true, maxBuffer: MAX_TABLE_BYTES },
    );
    return parseProcessTable(stdout);
  }
  // POSIX: `ps` lists every process as "pid ppid". (Not reached in production —
  // startParentWatchdog only reads the table on win32 — but kept platform-
  // agnostic so the module is usable/testable anywhere.)
  const { stdout } = await execFileAsync('ps', ['-Ao', 'pid=,ppid='], {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: MAX_TABLE_BYTES,
  });
  return parseProcessTable(stdout);
}

export function defaultIsAlive(pid: number): boolean {
  try {
    // Signal 0 performs existence/permission checks without delivering a signal.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by another user — still alive.
    // Anything else (notably ESRCH) means it is gone.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface ParentWatchdogOptions {
  /** Poll interval in ms. Defaults to KUSTO_PARENT_WATCHDOG_INTERVAL_MS or 60s. */
  intervalMs?: number;
  /** Liveness probe; overridable for tests. Defaults to `process.kill(pid, 0)`. */
  isAlive?: (pid: number) => boolean;
  /** Pre-resolved ancestor PIDs; overridable for tests. */
  ancestors?: number[];
  /** Process-table reader; overridable for tests. Defaults to the OS query. */
  readProcessTable?: () => Promise<Map<number, number>> | Map<number, number>;
}

/**
 * Start the orphan watchdog. Resolves to a stop function (also handy for tests).
 * Resolves to a no-op when disabled, when running on a platform where stdin EOF
 * already suffices (non-Windows), or when no ancestors can be resolved.
 */
export async function startParentWatchdog(
  onOrphaned: (deadAncestorPid: number) => void,
  options: ParentWatchdogOptions = {},
): Promise<() => void> {
  if (!isEnabled()) {
    debugLog('Parent watchdog disabled via KUSTO_ENABLE_PARENT_WATCHDOG');
    return () => {};
  }

  let ancestors = options.ancestors;
  if (!ancestors) {
    const readTable = options.readProcessTable;
    // The stdin-EOF handlers already cover disconnects on POSIX; only Windows
    // needs the ancestor snapshot. (An injected reader bypasses the gate so the
    // read/error paths remain testable on Linux CI.)
    if (!readTable && process.platform !== 'win32') {
      debugLog('Parent watchdog inactive (non-Windows: stdin EOF is reliable)');
      return () => {};
    }
    try {
      ancestors = computeAncestors(
        process.pid,
        await (readTable ?? readProcessTable)(),
      );
    } catch (error) {
      debugLog(
        `Parent watchdog disabled (could not read process table): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return () => {};
    }
  }

  if (ancestors.length === 0) {
    debugLog('Parent watchdog disabled (no ancestors resolved)');
    return () => {};
  }

  const watched = ancestors;
  const isAlive = options.isAlive ?? defaultIsAlive;
  const intervalMs = resolveIntervalMs(options.intervalMs);

  debugLog(
    `Parent watchdog armed (ancestors=[${watched.join(
      ', ',
    )}], interval=${intervalMs}ms)`,
  );

  const timer = setInterval(() => {
    for (const pid of watched) {
      if (!isAlive(pid)) {
        criticalLog(
          `Ancestor process ${pid} exited; MCP client is gone, shutting down`,
        );
        clearInterval(timer);
        onOrphaned(pid);
        return;
      }
    }
  }, intervalMs);

  // Never keep an otherwise-idle event loop alive on the watchdog's account.
  timer.unref();

  return () => clearInterval(timer);
}

function isEnabled(): boolean {
  // Default on; mirror the negative-form parsing of KUSTO_ALLOW_WRITE_OPERATIONS.
  const value = process.env.KUSTO_ENABLE_PARENT_WATCHDOG?.toLowerCase();
  return !(value === 'false' || value === '0' || value === 'no');
}

export function resolveIntervalMs(override?: number): number {
  if (typeof override === 'number' && Number.isFinite(override)) {
    return Math.max(MIN_INTERVAL_MS, override);
  }
  const raw = process.env.KUSTO_PARENT_WATCHDOG_INTERVAL_MS;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? Math.max(MIN_INTERVAL_MS, parsed)
    : DEFAULT_INTERVAL_MS;
}
