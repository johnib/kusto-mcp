/**
 * Orphan watchdog — Windows-safe disconnect detection. On Windows the MCP
 * client launches the server through intermediary cmd/npx processes that hold
 * stdin's write end open, so stdin never reaches EOF when the client dies and
 * the server is orphaned (spinning on a dead pipe, burning CPU). The watchdog
 * snapshots the ancestor PID chain and exits when any ancestor disappears.
 *
 * These tests exercise the pure logic (chain walking, table parsing, interval
 * resolution, liveness probe) and the timer loop with injected dependencies, so
 * they run deterministically on any platform without spawning real processes.
 */

import {
  computeAncestors,
  defaultIsAlive,
  parseProcessTable,
  resolveIntervalMs,
  startParentWatchdog,
} from '../../../src/common/parent-watchdog.js';

describe('parent-watchdog', () => {
  describe('parseProcessTable', () => {
    it('parses "pid ppid" lines and ignores headers/blank/garbage', () => {
      const map = parseProcessTable(
        'PID PPID\n100 1\n  200 100 \n\ngarbage line\n300 200\n',
      );
      expect(map.get(100)).toBe(1);
      expect(map.get(200)).toBe(100);
      expect(map.get(300)).toBe(200);
      expect(map.size).toBe(3);
    });
  });

  describe('computeAncestors', () => {
    it('walks from the start pid up to the root', () => {
      const map = new Map<number, number>([
        [500, 400],
        [400, 300],
        [300, 1],
      ]);
      expect(computeAncestors(500, map)).toEqual([400, 300, 1]);
    });

    it('stops on missing links and non-positive roots', () => {
      expect(computeAncestors(10, new Map([[10, 0]]))).toEqual([]);
      expect(computeAncestors(10, new Map())).toEqual([]);
    });

    it('is cycle-safe', () => {
      expect(
        computeAncestors(
          10,
          new Map([
            [10, 20],
            [20, 10],
          ]),
        ),
      ).toEqual([20]);
    });
  });

  describe('defaultIsAlive', () => {
    afterEach(() => jest.restoreAllMocks());

    it('reports the current process as alive', () => {
      expect(defaultIsAlive(process.pid)).toBe(true);
    });

    it('treats EPERM (process owned by another user) as alive', () => {
      jest.spyOn(process, 'kill').mockImplementation(() => {
        const err: NodeJS.ErrnoException = new Error('operation not permitted');
        err.code = 'EPERM';
        throw err;
      });
      expect(defaultIsAlive(999999)).toBe(true);
    });

    it('treats ESRCH (no such process) as dead', () => {
      jest.spyOn(process, 'kill').mockImplementation(() => {
        const err: NodeJS.ErrnoException = new Error('no such process');
        err.code = 'ESRCH';
        throw err;
      });
      expect(defaultIsAlive(999999)).toBe(false);
    });

    it('treats an unknown error as dead', () => {
      jest.spyOn(process, 'kill').mockImplementation(() => {
        throw new Error('weird');
      });
      expect(defaultIsAlive(999999)).toBe(false);
    });
  });

  describe('resolveIntervalMs', () => {
    afterEach(() => {
      delete process.env.KUSTO_PARENT_WATCHDOG_INTERVAL_MS;
    });

    it('clamps explicit overrides to the minimum', () => {
      expect(resolveIntervalMs(250)).toBe(1000);
      expect(resolveIntervalMs(60_000)).toBe(60_000);
    });

    it('reads and clamps the env var when no override is given', () => {
      process.env.KUSTO_PARENT_WATCHDOG_INTERVAL_MS = '250';
      expect(resolveIntervalMs()).toBe(1000);
      process.env.KUSTO_PARENT_WATCHDOG_INTERVAL_MS = '30000';
      expect(resolveIntervalMs()).toBe(30_000);
    });

    it.each(['abc', '', '0', '-5'])(
      'falls back to the 60s default for invalid env value %p',
      value => {
        process.env.KUSTO_PARENT_WATCHDOG_INTERVAL_MS = value;
        expect(resolveIntervalMs()).toBe(60_000);
      },
    );
  });

  describe('startParentWatchdog', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => {
      jest.clearAllTimers();
      jest.useRealTimers();
      delete process.env.KUSTO_ENABLE_PARENT_WATCHDOG;
      delete process.env.KUSTO_PARENT_WATCHDOG_INTERVAL_MS;
    });

    it('fires onOrphaned exactly once when an ancestor dies, then stops', async () => {
      const dead = new Set<number>();
      const onOrphaned = jest.fn();
      await startParentWatchdog(onOrphaned, {
        ancestors: [100, 200],
        intervalMs: 1000,
        isAlive: pid => !dead.has(pid),
      });

      jest.advanceTimersByTime(1000);
      expect(onOrphaned).not.toHaveBeenCalled();

      dead.add(200);
      jest.advanceTimersByTime(1000);
      expect(onOrphaned).toHaveBeenCalledWith(200);
      expect(onOrphaned).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(5000);
      expect(onOrphaned).toHaveBeenCalledTimes(1);
    });

    it('returns a stop() that cancels the watchdog', async () => {
      const onOrphaned = jest.fn();
      const stop = await startParentWatchdog(onOrphaned, {
        ancestors: [100],
        intervalMs: 1000,
        isAlive: () => false,
      });
      stop();
      jest.advanceTimersByTime(5000);
      expect(onOrphaned).not.toHaveBeenCalled();
    });

    it.each(['false', '0', 'no', 'FALSE'])(
      'is a no-op when disabled via KUSTO_ENABLE_PARENT_WATCHDOG=%p',
      async value => {
        process.env.KUSTO_ENABLE_PARENT_WATCHDOG = value;
        const onOrphaned = jest.fn();
        await startParentWatchdog(onOrphaned, {
          ancestors: [100],
          intervalMs: 1000,
          isAlive: () => false,
        });
        jest.advanceTimersByTime(5000);
        expect(onOrphaned).not.toHaveBeenCalled();
      },
    );

    it('arms when KUSTO_ENABLE_PARENT_WATCHDOG is truthy/unset', async () => {
      process.env.KUSTO_ENABLE_PARENT_WATCHDOG = 'true';
      const onOrphaned = jest.fn();
      await startParentWatchdog(onOrphaned, {
        ancestors: [100],
        intervalMs: 1000,
        isAlive: () => false,
      });
      jest.advanceTimersByTime(1000);
      expect(onOrphaned).toHaveBeenCalledWith(100);
    });

    it('is a no-op when no ancestors resolve', async () => {
      const onOrphaned = jest.fn();
      await startParentWatchdog(onOrphaned, {
        ancestors: [],
        intervalMs: 1000,
        isAlive: () => false,
      });
      jest.advanceTimersByTime(5000);
      expect(onOrphaned).not.toHaveBeenCalled();
    });

    it('disables (never fires, never throws) when the process-table read fails', async () => {
      const onOrphaned = jest.fn();
      const stop = await startParentWatchdog(onOrphaned, {
        intervalMs: 1000,
        isAlive: () => false,
        readProcessTable: () => {
          throw new Error('boom');
        },
      });
      jest.advanceTimersByTime(5000);
      expect(onOrphaned).not.toHaveBeenCalled();
      expect(typeof stop).toBe('function');
    });

    it('resolves ancestors from an injected process-table reader', async () => {
      const onOrphaned = jest.fn();
      const dead = new Set<number>();
      // process.pid -> 4242 -> 1 ; watch the chain, then kill 4242.
      await startParentWatchdog(onOrphaned, {
        intervalMs: 1000,
        isAlive: pid => !dead.has(pid),
        readProcessTable: () =>
          new Map<number, number>([
            [process.pid, 4242],
            [4242, 1],
          ]),
      });
      jest.advanceTimersByTime(1000);
      expect(onOrphaned).not.toHaveBeenCalled();
      dead.add(4242);
      jest.advanceTimersByTime(1000);
      expect(onOrphaned).toHaveBeenCalledWith(4242);
    });
  });
});
