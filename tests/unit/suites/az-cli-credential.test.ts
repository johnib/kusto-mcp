/**
 * #346: our az credential must kill the whole `az` process tree on timeout or
 * abort (Windows: taskkill /T /F; POSIX: the detached process group), parse
 * the token, and map failures to CredentialUnavailableError so #339's hints
 * and the auth.failure_stage telemetry keep working.
 */
import { EventEmitter } from 'node:events';

jest.unmock('../../../src/auth/az-cli-credential.js');

const safeSpawn = jest.fn();
jest.mock('@azure/core-process', () => ({
  spawn: (...args: unknown[]) => safeSpawn(...args),
}));

const nodeSpawn = jest.fn();
jest.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => nodeSpawn(...args),
}));

import {
  AzCliCredential,
  CredentialUnavailableError,
  azCliFailure,
  killProcessTree,
  parseAzCliTokenResponse,
} from '../../../src/auth/az-cli-credential.js';
import {
  CachingTokenCredential,
  createTokenCredential,
} from '../../../src/auth/token-credentials.js';
import {
  captureIdentity,
  clearIdentity,
  getIdentityAttributes,
} from '../../../src/common/identity.js';

class FakeChild extends EventEmitter {
  pid: number | undefined = 4242;
  stdout = Object.assign(new EventEmitter(), { setEncoding: jest.fn() });
  stderr = Object.assign(new EventEmitter(), { setEncoding: jest.fn() });
  kill = jest.fn();
  /** Write output and exit. */
  exit(code: number, out = '', err = '') {
    if (out) this.stdout.emit('data', out);
    if (err) this.stderr.emit('data', err);
    this.emit('close', code);
  }
}

const SCOPE = 'https://help.kusto.windows.net/.default';
const originalPlatform = process.platform;
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: p });
}

let child: FakeChild;
let killSpy: jest.SpyInstance;

beforeEach(() => {
  jest.useRealTimers();
  safeSpawn.mockReset();
  nodeSpawn.mockReset();
  child = new FakeChild();
  safeSpawn.mockImplementation(() => child);
  nodeSpawn.mockImplementation(() => new EventEmitter());
  killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
});

afterEach(() => {
  setPlatform(originalPlatform);
  killSpy.mockRestore();
  jest.useRealTimers();
});

describe('parseAzCliTokenResponse', () => {
  test('prefers expires_on (epoch seconds)', () => {
    const t = parseAzCliTokenResponse(
      JSON.stringify({
        accessToken: 'tok',
        expires_on: 1900000000,
        expiresOn: '2001-01-01 00:00:00.000000',
      }),
    );
    expect(t).toEqual({
      token: 'tok',
      expiresOnTimestamp: 1900000000000,
      tokenType: 'Bearer',
    });
  });

  test('falls back to expiresOn on older az', () => {
    const t = parseAzCliTokenResponse(
      JSON.stringify({ accessToken: 'tok', expiresOn: '2030-01-01T00:00:00Z' }),
    );
    expect(t.expiresOnTimestamp).toBe(Date.parse('2030-01-01T00:00:00Z'));
  });

  test.each([
    ['not json', 'garbage'],
    ['no token', JSON.stringify({ expires_on: 1 })],
    ['no expiry', JSON.stringify({ accessToken: 'tok' })],
  ])('%s → CredentialUnavailableError without echoing output', (_, out) => {
    let err: unknown;
    try {
      parseAzCliTokenResponse(out);
    } catch (e) {
      err = e;
    }
    expect((err as Error).name).toBe('CredentialUnavailableError');
    expect((err as Error).message).not.toContain('garbage');
  });
});

describe('azCliFailure', () => {
  test('not logged in', () => {
    const e = azCliFailure("ERROR: Please run 'az login' to setup account.");
    expect(e.name).toBe('CredentialUnavailableError');
    expect(e.message).toMatch(/run 'az login'/);
  });

  test('not installed (cmd.exe)', () => {
    const e = azCliFailure(
      "'az' is not recognized as an internal or external command",
    );
    expect(e.message).toMatch(/could not be found/);
  });

  test('other stderr is passed through', () => {
    expect(azCliFailure('ERROR: boom').message).toBe('ERROR: boom');
  });
});

describe('AzCliCredential.getToken', () => {
  test('runs az get-access-token for the scope resource, no shell', async () => {
    const p = new AzCliCredential({ timeoutMs: 1000 }).getToken([SCOPE]);
    child.exit(0, JSON.stringify({ accessToken: 'tok', expires_on: 2 }));
    await expect(p).resolves.toMatchObject({ token: 'tok' });
    const [cmd, args, opts] = safeSpawn.mock.calls[0];
    expect(cmd).toBe('az');
    expect(args).toEqual([
      'account',
      'get-access-token',
      '--output',
      'json',
      '--resource',
      'https://help.kusto.windows.net',
    ]);
    expect(opts).toMatchObject({ allowWindowsBatchFiles: true });
    expect(opts.shell).toBeUndefined();
  });

  test('POSIX: spawns detached so the tree is one process group', async () => {
    setPlatform('linux');
    const p = new AzCliCredential().getToken(SCOPE);
    child.exit(0, JSON.stringify({ accessToken: 'tok', expires_on: 2 }));
    await p;
    expect(safeSpawn.mock.calls[0][2].detached).toBe(true);
  });

  test('Windows: not detached', async () => {
    setPlatform('win32');
    const p = new AzCliCredential().getToken(SCOPE);
    child.exit(0, JSON.stringify({ accessToken: 'tok', expires_on: 2 }));
    await p;
    expect(safeSpawn.mock.calls[0][2].detached).toBe(false);
  });

  test('az not on PATH → credential_unavailable', async () => {
    safeSpawn.mockImplementation(() => {
      throw Object.assign(new Error('x'), { code: 'ENOENT' });
    });
    await expect(new AzCliCredential().getToken(SCOPE)).rejects.toMatchObject({
      name: 'CredentialUnavailableError',
      message: expect.stringMatching(/could not be found/),
    });
  });

  test('spawn error event ENOENT → not installed', async () => {
    const p = new AzCliCredential().getToken(SCOPE);
    child.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' }));
    await expect(p).rejects.toMatchObject({
      message: expect.stringMatching(/could not be found/),
    });
  });

  test('not logged in → CredentialUnavailableError', async () => {
    const p = new AzCliCredential().getToken(SCOPE);
    child.exit(1, '', "ERROR: Please run 'az login' to setup account.");
    await expect(p).rejects.toBeInstanceOf(CredentialUnavailableError);
  });

  test('rejects an unsafe scope without spawning', async () => {
    await expect(
      new AzCliCredential().getToken('https://x/.default & calc'),
    ).rejects.toMatchObject({ name: 'CredentialUnavailableError' });
    expect(safeSpawn).not.toHaveBeenCalled();
  });

  test('passes the request tenant as --tenant, like the SDK', async () => {
    const p = new AzCliCredential().getToken(SCOPE, { tenantId: 'contoso-1' });
    child.exit(0, JSON.stringify({ accessToken: 'tok', expires_on: 2 }));
    await p;
    expect(safeSpawn.mock.calls[0][1].slice(-2)).toEqual([
      '--tenant',
      'contoso-1',
    ]);
  });

  test('rejects an unsafe tenant without spawning', async () => {
    await expect(
      new AzCliCredential().getToken(SCOPE, { tenantId: 'x & calc' }),
    ).rejects.toMatchObject({ name: 'CredentialUnavailableError' });
    expect(safeSpawn).not.toHaveBeenCalled();
  });

  test('claims challenge → CredentialUnavailableError', async () => {
    await expect(
      new AzCliCredential().getToken(SCOPE, { claims: 'abc' }),
    ).rejects.toMatchObject({ name: 'CredentialUnavailableError' });
    expect(safeSpawn).not.toHaveBeenCalled();
  });

  describe('timeout kills the whole tree', () => {
    test('Windows: taskkill /PID <pid> /T /F, root not killed first', async () => {
      setPlatform('win32');
      jest.useFakeTimers();
      const p = new AzCliCredential({ timeoutMs: 1500 }).getToken(SCOPE);
      const settled = expect(p).rejects.toMatchObject({
        name: 'CredentialUnavailableError',
        message: expect.stringMatching(/timed out/),
      });
      jest.advanceTimersByTime(1499);
      expect(nodeSpawn).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      await settled;
      expect(nodeSpawn).toHaveBeenCalledTimes(1);
      const [exe, args] = nodeSpawn.mock.calls[0];
      expect(String(exe).toLowerCase()).toMatch(/system32\\taskkill\.exe$/);
      expect(args).toEqual(['/PID', '4242', '/T', '/F']);
      expect(child.kill).not.toHaveBeenCalled();
      expect(killSpy).not.toHaveBeenCalled();
    });

    test('POSIX: SIGKILL to the process group (-pid)', async () => {
      setPlatform('darwin');
      jest.useFakeTimers();
      const p = new AzCliCredential({ timeoutMs: 1500 }).getToken(SCOPE);
      const settled = expect(p).rejects.toMatchObject({
        message: expect.stringMatching(/timed out/),
      });
      jest.advanceTimersByTime(1500);
      await settled;
      expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');
      expect(nodeSpawn).not.toHaveBeenCalled();
    });

    test("with a caller's deadline, az measures its bound when it spawns (before the deadline)", async () => {
      setPlatform('darwin');
      jest.useFakeTimers();
      // 3.5s of a 5s budget went to metadata / earlier chain steps.
      const deadlineAt = Date.now() + 1500;
      const p = new AzCliCredential({ timeoutMs: 19000 }).getToken(SCOPE, {
        kustoMcpAzDeadlineAt: deadlineAt,
      } as never);
      const settled = expect(p).rejects.toMatchObject({
        azReason: 'timeout',
      });
      // Half of the 1.5s left: az fails as an az timeout at 750ms, well
      // before the caller's deadline (the fixed 19s bound would be after).
      jest.advanceTimersByTime(749);
      expect(killSpy).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      await settled;
      expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');
    });

    test('a late exit after the timeout is ignored', async () => {
      setPlatform('linux');
      jest.useFakeTimers();
      const p = new AzCliCredential({ timeoutMs: 10 }).getToken(SCOPE);
      const settled = expect(p).rejects.toMatchObject({
        message: expect.stringMatching(/timed out/),
      });
      jest.advanceTimersByTime(10);
      child.exit(0, JSON.stringify({ accessToken: 'tok', expires_on: 2 }));
      await settled;
    });

    test('no kill when az finishes in time', async () => {
      setPlatform('win32');
      jest.useFakeTimers();
      const p = new AzCliCredential({ timeoutMs: 1500 }).getToken(SCOPE);
      child.exit(0, JSON.stringify({ accessToken: 'tok', expires_on: 2 }));
      await p;
      jest.advanceTimersByTime(5000);
      expect(nodeSpawn).not.toHaveBeenCalled();
    });
  });

  describe('abort signal', () => {
    test('abort kills the tree and rejects with AbortError', async () => {
      setPlatform('linux');
      const ac = new AbortController();
      const p = new AzCliCredential().getToken(SCOPE, {
        abortSignal: ac.signal,
      });
      ac.abort();
      await expect(p).rejects.toMatchObject({ name: 'AbortError' });
      expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');
    });

    test('already-aborted signal never spawns', async () => {
      const ac = new AbortController();
      ac.abort();
      await expect(
        new AzCliCredential().getToken(SCOPE, { abortSignal: ac.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(safeSpawn).not.toHaveBeenCalled();
    });
  });
});

describe('killProcessTree never throws', () => {
  test('taskkill spawn throws', () => {
    nodeSpawn.mockImplementation(() => {
      throw new Error('nope');
    });
    expect(() => killProcessTree(child as never, 'win32')).not.toThrow();
  });

  test('taskkill emits error (e.g. missing) is swallowed', () => {
    const killer = new EventEmitter();
    nodeSpawn.mockImplementation(() => killer);
    killProcessTree(child as never, 'win32');
    expect(() => killer.emit('error', new Error('ENOENT'))).not.toThrow();
  });

  test('POSIX group kill fails → falls back to child.kill', () => {
    killSpy.mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });
    expect(() => killProcessTree(child as never, 'linux')).not.toThrow();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  test('no pid (spawn failed) → no taskkill', () => {
    child.pid = undefined;
    killProcessTree(child as never, 'win32');
    expect(nodeSpawn).not.toHaveBeenCalled();
  });
});

describe('wiring', () => {
  test('azure-cli uses AzCliCredential (inside the token cache)', () => {
    const cred = createTokenCredential('azure-cli', 1500);
    expect(cred).toBeInstanceOf(CachingTokenCredential);
    expect((cred as unknown as { inner: unknown }).inner).toBeInstanceOf(
      AzCliCredential,
    );
  });

  test('azure-cli asks az for --tenant organizations, as 1.18.0 did', async () => {
    const cred = createTokenCredential('azure-cli', 1500);
    const p = cred.getToken(SCOPE);
    child.exit(0, JSON.stringify({ accessToken: 'tok', expires_on: 2 }));
    await p;
    expect(safeSpawn.mock.calls[0][1].slice(-2)).toEqual([
      '--tenant',
      'organizations',
    ]);
  });

  describe('aborting the factory credential kills the az tree', () => {
    test('Windows: taskkill /T /F', async () => {
      setPlatform('win32');
      const ac = new AbortController();
      const cred = createTokenCredential('azure-cli', 60000);
      const p = cred.getToken(SCOPE, { abortSignal: ac.signal });
      ac.abort();
      await expect(p).rejects.toMatchObject({ name: 'AbortError' });
      expect(nodeSpawn).toHaveBeenCalledTimes(1);
      const [exe, args] = nodeSpawn.mock.calls[0];
      expect(String(exe).toLowerCase()).toMatch(/system32\\taskkill\.exe$/);
      expect(args).toEqual(['/PID', '4242', '/T', '/F']);
    });

    test('POSIX: SIGKILL to the process group', async () => {
      setPlatform('linux');
      const ac = new AbortController();
      const cred = createTokenCredential('azure-cli', 60000);
      const p = cred.getToken(SCOPE, { abortSignal: ac.signal });
      ac.abort();
      await expect(p).rejects.toMatchObject({ name: 'AbortError' });
      expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');
    });
  });

  test('a timed-out az still classifies as credential_unavailable (#339)', async () => {
    clearIdentity();
    jest.useFakeTimers();
    const cred = createTokenCredential('azure-cli', 50);
    const p = captureIdentity('https://help.kusto.windows.net', s =>
      cred.getToken(s),
    );
    jest.advanceTimersByTime(50);
    await p;
    expect(getIdentityAttributes()).toMatchObject({
      'kustomcp.identity_state': 'unavailable',
      'kustomcp.auth.failure_stage': 'credential_unavailable',
    });
  });
});
