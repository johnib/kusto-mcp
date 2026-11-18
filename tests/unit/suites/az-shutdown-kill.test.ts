/**
 * #443 — an `az` that runs when the server shuts down (stdin EOF, SIGTERM,
 * client disconnect) must not outlive it. The tree kill from #346 ran only on
 * our own timeout/abort while the server stayed alive; shutdown now kills the
 * tree of every running `az` (Windows: taskkill /T /F, awaited with a bound;
 * POSIX: the process group) before the process exits.
 *
 * Shutdown is crash-path code (#180/#196): it never throws and never hangs.
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createShutdown } from '../../../src/common/shutdown.js';

jest.unmock('../../../src/auth/az-cli-credential.js');

const safeSpawn = jest.fn();
jest.mock('@azure/core-process', () => ({
  spawn: (...args: unknown[]) => safeSpawn(...args),
}));

const nodeSpawn = jest.fn();
jest.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => nodeSpawn(...args),
}));

type AzModule = typeof import('../../../src/auth/az-cli-credential.js');

class FakeChild extends EventEmitter {
  stdout = Object.assign(new EventEmitter(), { setEncoding: jest.fn() });
  stderr = Object.assign(new EventEmitter(), { setEncoding: jest.fn() });
  kill = jest.fn();
  constructor(public pid: number | undefined) {
    super();
  }
}

const SCOPE = 'https://help.kusto.windows.net/.default';
const originalPlatform = process.platform;
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: p });
}

let az: AzModule;
let killSpy: jest.SpyInstance;
let nextPid: number;
let killers: EventEmitter[];

/** Start a getToken whose az never exits; returns its child. */
function startHungAz(): FakeChild {
  const child = new FakeChild(nextPid++);
  safeSpawn.mockImplementationOnce(() => child);
  new az.AzCliCredential().getToken(SCOPE).catch(() => {});
  return child;
}

beforeEach(async () => {
  // The module keeps the running children and the shutdown flag; start clean.
  jest.resetModules();
  az = await import('../../../src/auth/az-cli-credential.js');
  safeSpawn.mockReset();
  nodeSpawn.mockReset();
  nextPid = 5000;
  killers = [];
  nodeSpawn.mockImplementation(() => {
    const killer = new EventEmitter();
    killers.push(killer);
    return killer;
  });
  killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
});

afterEach(() => {
  setPlatform(originalPlatform);
  killSpy.mockRestore();
  jest.useRealTimers();
});

describe('killRunningAzChildren (#443)', () => {
  test('POSIX: SIGKILL to the process group of each running az', async () => {
    setPlatform('darwin');
    startHungAz();
    startHungAz();
    expect(az.runningAzChildCount()).toBe(2);

    await az.killRunningAzChildren();

    expect(killSpy.mock.calls).toEqual([
      [-5000, 'SIGKILL'],
      [-5001, 'SIGKILL'],
    ]);
    expect(nodeSpawn).not.toHaveBeenCalled();
  });

  test('Windows: taskkill /T /F for each running az, and waits for taskkill to exit', async () => {
    setPlatform('win32');
    startHungAz();
    startHungAz();

    let done = false;
    const kill = az.killRunningAzChildren().then(() => {
      done = true;
    });

    expect(nodeSpawn.mock.calls.map(c => c[1])).toEqual([
      ['/PID', '5000', '/T', '/F'],
      ['/PID', '5001', '/T', '/F'],
    ]);
    expect(String(nodeSpawn.mock.calls[0][0]).toLowerCase()).toMatch(
      /system32\\taskkill\.exe$/,
    );

    killers[0].emit('exit', 0);
    await new Promise(r => setImmediate(r));
    expect(done).toBe(false); // the second taskkill still runs

    killers[1].emit('exit', 0);
    await kill;
    expect(done).toBe(true);
  });

  test('Windows: a taskkill that never exits is bounded', async () => {
    setPlatform('win32');
    startHungAz();
    const started = Date.now();
    await az.killRunningAzChildren(50);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(nodeSpawn).toHaveBeenCalledTimes(1);
  });

  test('the default bound is short', () => {
    expect(az.AZ_SHUTDOWN_KILL_WAIT_MS).toBeLessThanOrEqual(2000);
  });

  test('no kill when no az runs', async () => {
    for (const platform of ['win32', 'darwin'] as const) {
      setPlatform(platform);
      await az.killRunningAzChildren();
    }
    expect(nodeSpawn).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
  });

  test('no kill for an az that already exited', async () => {
    setPlatform('darwin');
    const finished = startHungAz();
    finished.emit('close', 1);
    const running = startHungAz();
    expect(az.runningAzChildCount()).toBe(1);

    await az.killRunningAzChildren();

    expect(killSpy.mock.calls).toEqual([[-running.pid!, 'SIGKILL']]);
  });

  test('a failed spawn (error event, no pid) is not tracked', async () => {
    setPlatform('win32');
    const child = new FakeChild(undefined);
    safeSpawn.mockImplementationOnce(() => child);
    const token = new az.AzCliCredential().getToken(SCOPE);
    child.emit('error', Object.assign(new Error('nope'), { code: 'ENOENT' }));
    await expect(token).rejects.toMatchObject({
      name: 'CredentialUnavailableError',
    });
    expect(az.runningAzChildCount()).toBe(0);
  });

  test('an az killed by its timeout stays tracked until it closes, so shutdown kills it again', async () => {
    // The issue's second case: the client exits right after an az timeout,
    // before taskkill is done.
    setPlatform('win32');
    jest.useFakeTimers();
    const child = new FakeChild(nextPid++);
    safeSpawn.mockImplementationOnce(() => child);
    const token = new az.AzCliCredential({ timeoutMs: 1000 }).getToken(SCOPE);
    const settled = expect(token).rejects.toMatchObject({
      message: expect.stringMatching(/timed out/),
    });
    jest.advanceTimersByTime(1000);
    await settled;
    jest.useRealTimers();
    expect(nodeSpawn).toHaveBeenCalledTimes(1); // the timeout's taskkill
    expect(az.runningAzChildCount()).toBe(1);

    const kill = az.killRunningAzChildren();
    expect(nodeSpawn).toHaveBeenCalledTimes(2);
    killers[1].emit('exit', 0);
    await kill;

    child.emit('close', null);
    expect(az.runningAzChildCount()).toBe(0);
  });

  describe('kill errors are swallowed', () => {
    test('Windows: taskkill spawn throws', async () => {
      setPlatform('win32');
      startHungAz();
      startHungAz();
      nodeSpawn.mockImplementation(() => {
        throw new Error('EPERM');
      });
      await expect(az.killRunningAzChildren()).resolves.toBeUndefined();
      expect(nodeSpawn).toHaveBeenCalledTimes(2); // still tried each child
    });

    test('Windows: taskkill emits error (e.g. missing)', async () => {
      setPlatform('win32');
      startHungAz();
      const kill = az.killRunningAzChildren();
      killers[0].emit('error', new Error('ENOENT'));
      await expect(kill).resolves.toBeUndefined();
    });

    test('POSIX: group kill and child.kill both throw; later children are still killed', async () => {
      setPlatform('linux');
      const first = startHungAz();
      startHungAz();
      first.kill.mockImplementation(() => {
        throw new Error('ESRCH');
      });
      killSpy.mockImplementation((pid: number) => {
        if (pid === -5000) throw new Error('ESRCH');
        return true;
      });
      await expect(az.killRunningAzChildren()).resolves.toBeUndefined();
      expect(killSpy).toHaveBeenCalledWith(-5001, 'SIGKILL');
    });
  });

  test('Windows: a taskkill that emits both error and exit is counted once', async () => {
    setPlatform('win32');
    startHungAz();
    startHungAz();
    let done = false;
    const kill = az.killRunningAzChildren().then(() => {
      done = true;
    });
    killers[0].emit('error', new Error('boom'));
    killers[0].emit('exit', 1);
    await new Promise(r => setImmediate(r));
    expect(done).toBe(false); // the second taskkill still runs
    killers[1].emit('exit', 0);
    await kill;
  });

  test('Windows: no taskkill for a root that already exited (its pid may be reused)', async () => {
    setPlatform('win32');
    const exited = startHungAz() as FakeChild & { exitCode: number | null };
    exited.exitCode = 1; // exited, but a grandchild holds the pipes: no close
    startHungAz();
    const kill = az.killRunningAzChildren();
    expect(nodeSpawn.mock.calls.map(c => c[1])).toEqual([
      ['/PID', '5001', '/T', '/F'],
    ]);
    killers[0].emit('exit', 0);
    await kill;
  });

  test('an az that the shutdown killed fails as an abort, not as a credential failure', async () => {
    // A CredentialUnavailableError would make a credential chain go on and
    // start its next process during shutdown.
    setPlatform('darwin');
    const child = new FakeChild(nextPid++);
    safeSpawn.mockImplementationOnce(() => child);
    const token = new az.AzCliCredential().getToken(SCOPE);
    const settled = expect(token).rejects.toMatchObject({ name: 'AbortError' });
    await az.killRunningAzChildren();
    child.emit('close', null);
    await settled;
  });

  test('after shutdown started, getToken starts no new az', async () => {
    setPlatform('darwin');
    await az.killRunningAzChildren();
    await expect(
      new az.AzCliCredential().getToken(SCOPE),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(safeSpawn).not.toHaveBeenCalled();
  });
});

describe('shutdown kills running az children before exit (#443)', () => {
  const never = () => new Promise<never>(() => {});

  function steps(
    overrides: Partial<Parameters<typeof createShutdown>[0]> = {},
  ) {
    const events: string[] = [];
    const exit = jest.fn((code: number) => {
      events.push(`exit:${code}`);
    });
    const shutdown = createShutdown({
      closeServer: async () => {
        events.push('close');
      },
      drainCancels: async () => {},
      flushTelemetry: async () => {
        events.push('flush');
      },
      exit,
      log: () => {},
      ...overrides,
    });
    return { events, exit, shutdown };
  }

  test('the real kill step runs for each running az, and exit waits for it', async () => {
    setPlatform('win32');
    startHungAz();
    startHungAz();
    const { events, exit, shutdown } = steps({
      killChildren: () => {
        events.push('kill');
        return az.killRunningAzChildren();
      },
    });

    const done = shutdown('client-disconnect');
    // Started at once, before the server close.
    expect(nodeSpawn).toHaveBeenCalledTimes(2);
    expect(events).toEqual(['kill', 'close']);

    await new Promise(r => setTimeout(r, 50));
    expect(exit).not.toHaveBeenCalled(); // taskkill still runs

    killers.forEach(k => k.emit('exit', 0));
    await done;
    expect(events).toEqual(['kill', 'close', 'flush', 'exit:0']);
  });

  test('no az running: shutdown kills nothing and exits', async () => {
    const { exit, shutdown } = steps({
      killChildren: () => az.killRunningAzChildren(),
    });
    await shutdown('SIGTERM');
    expect(nodeSpawn).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  test('a kill step that throws, rejects or hangs never stops the exit', async () => {
    const failing: Array<() => Promise<unknown> | void> = [
      () => {
        throw new Error('kill failed');
      },
      async () => {
        throw new Error('kill rejected');
      },
      never,
    ];
    for (const killChildren of failing) {
      const { events, exit, shutdown } = steps({ killChildren, killCapMs: 50 });
      await expect(shutdown('uncaughtException', 1)).resolves.toBeUndefined();
      expect(exit).toHaveBeenCalledTimes(1);
      expect(events).toEqual(['close', 'flush', 'exit:1']);
    }
  });

  test('index.ts wires the az kill into the shutdown routine', () => {
    const source = readFileSync(
      join(__dirname, '../../../src/index.ts'),
      'utf8',
    );
    expect(source).toMatch(
      /createShutdown\(\{[^}]*killChildren:\s*\(\)\s*=>\s*killRunningAzChildren\(\)/,
    );
  });
});
