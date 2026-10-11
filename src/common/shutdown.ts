/**
 * Shutdown sequencing for the stdio server (#333).
 *
 * When the MCP client goes away (stdin EOF, signal, fatal error) we must:
 *   1. close the MCP server, so the SDK aborts in-flight request handlers —
 *      an aborted execute-query sends a best-effort `.cancel query` for its
 *      running Kusto query;
 *   2. give those `.cancel query` requests a short, bounded drain;
 *   3. flush telemetry and exit.
 *
 * This is crash-path code: nothing here may throw, and exit must happen within
 * a fixed bound even if a step hangs. A second failure inside a crash handler
 * is what turned #180/#196 into a 100% CPU spin.
 */

/** Upper bound for closing the server plus draining `.cancel query` requests. */
export const CANCEL_DRAIN_CAP_MS = 1500;

const pendingCancels = new Set<Promise<void>>();

/**
 * Track a best-effort `.cancel query` request so shutdown can wait for it to
 * reach the cluster before the process exits. Never throws.
 */
export function trackPendingCancel(request: Promise<unknown>): void {
  try {
    const settled: Promise<void> = Promise.resolve(request).then(
      () => {
        pendingCancels.delete(settled);
      },
      () => {
        pendingCancels.delete(settled);
      },
    );
    pendingCancels.add(settled);
  } catch {
    /* best effort */
  }
}

/** Number of `.cancel query` requests still in flight. */
export function pendingCancelCount(): number {
  return pendingCancels.size;
}

/** Resolves once every tracked `.cancel query` has settled. Never rejects. */
export async function settlePendingCancels(): Promise<void> {
  // Loop: settling one cancel never adds another, but stay correct if it does.
  while (pendingCancels.size > 0) {
    await Promise.all([...pendingCancels]);
  }
}

/**
 * Run `work` but give up after `ms`. Resolves either way; never rejects.
 * The timer is cleared when `work` wins, so it never holds the event loop.
 */
export async function withinDeadline(
  work: () => Promise<unknown>,
  ms: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => work())().catch(() => {}),
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } catch {
    /* never throw from the shutdown path */
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface ShutdownSteps {
  /** Close the MCP server; aborts in-flight request handlers. */
  closeServer: () => Promise<unknown>;
  /** Resolves when outstanding `.cancel query` requests have settled. */
  drainCancels: () => Promise<unknown>;
  /** Flush telemetry (bounded by its own timeout). */
  flushTelemetry: () => Promise<unknown>;
  exit: (code: number) => void;
  log: (message: string) => void;
  /** Bound for closeServer + drainCancels together. */
  drainCapMs?: number;
}

/**
 * Build the process's single shutdown routine. Repeat calls are no-ops, every
 * step is guarded, and `exit` is always called.
 */
export function createShutdown(
  steps: ShutdownSteps,
): (reason: string, code?: number) => Promise<void> {
  let shuttingDown = false;
  return async (reason, code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      try {
        steps.log(`Shutting down (${reason})`);
      } catch {
        /* stderr may already be gone */
      }
      await withinDeadline(async () => {
        // A close that rejects may already have aborted handlers and started
        // their `.cancel query` requests, so the drain must still run.
        try {
          await steps.closeServer();
        } catch {
          /* best effort */
        }
        await steps.drainCancels();
      }, steps.drainCapMs ?? CANCEL_DRAIN_CAP_MS);
      try {
        await steps.flushTelemetry();
      } catch {
        /* best effort */
      }
    } finally {
      steps.exit(code);
    }
  };
}
