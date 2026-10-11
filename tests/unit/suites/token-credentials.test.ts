/**
 * Token caching (#296): without it every Kusto request asks the credential
 * again, and AzureCliCredential spawns `az account get-access-token` each time.
 */
import type { AccessToken, TokenCredential } from '@azure/identity';
import {
  CachingTokenCredential,
  TOKEN_REFRESH_MARGIN_MS,
  createTokenCredential,
} from '../../../src/auth/token-credentials.js';

const SCOPE = 'https://kusto.kusto.windows.net/.default';
const HOUR = 60 * 60 * 1000;

function fakeInner(now: () => number, lifetimeMs = HOUR) {
  let n = 0;
  const getToken = jest.fn(async (): Promise<AccessToken | null> => ({
    token: `t${++n}`,
    expiresOnTimestamp: now() + lifetimeMs,
  }));
  return { getToken } as TokenCredential & { getToken: typeof getToken };
}

describe('CachingTokenCredential', () => {
  let clock: number;
  const now = () => clock;

  beforeEach(() => {
    clock = 1_000_000;
  });

  test('N sequential calls hit the inner credential once', async () => {
    const inner = fakeInner(now);
    const cred = new CachingTokenCredential(inner, now);
    const tokens = [];
    for (let i = 0; i < 10; i++) tokens.push(await cred.getToken(SCOPE));
    expect(inner.getToken).toHaveBeenCalledTimes(1);
    expect(new Set(tokens.map(t => t?.token))).toEqual(new Set(['t1']));
  });

  test('N concurrent calls share one in-flight request', async () => {
    const inner = fakeInner(now);
    const cred = new CachingTokenCredential(inner, now);
    const tokens = await Promise.all(
      Array.from({ length: 10 }, () => cred.getToken([SCOPE])),
    );
    expect(inner.getToken).toHaveBeenCalledTimes(1);
    expect(tokens.every(t => t?.token === 't1')).toBe(true);
  });

  test('refreshes once within the margin before expiry', async () => {
    const inner = fakeInner(now);
    const cred = new CachingTokenCredential(inner, now);
    await cred.getToken(SCOPE);

    clock += HOUR - TOKEN_REFRESH_MARGIN_MS - 1;
    expect((await cred.getToken(SCOPE))?.token).toBe('t1');
    expect(inner.getToken).toHaveBeenCalledTimes(1);

    clock += 2;
    expect((await cred.getToken(SCOPE))?.token).toBe('t2');
    expect((await cred.getToken(SCOPE))?.token).toBe('t2');
    expect(inner.getToken).toHaveBeenCalledTimes(2);
  });

  test('does not cache failures', async () => {
    const inner = fakeInner(now);
    inner.getToken.mockRejectedValueOnce(new Error('az not logged in'));
    const cred = new CachingTokenCredential(inner, now);

    await expect(cred.getToken(SCOPE)).rejects.toThrow('az not logged in');
    expect((await cred.getToken(SCOPE))?.token).toBe('t1');
    expect(inner.getToken).toHaveBeenCalledTimes(2);
  });

  test('does not cache null results', async () => {
    const inner = fakeInner(now);
    inner.getToken.mockResolvedValueOnce(null);
    const cred = new CachingTokenCredential(inner, now);

    expect(await cred.getToken(SCOPE)).toBeNull();
    expect((await cred.getToken(SCOPE))?.token).toBe('t1');
    expect(inner.getToken).toHaveBeenCalledTimes(2);
  });

  test('caches different scopes separately', async () => {
    const inner = fakeInner(now);
    const cred = new CachingTokenCredential(inner, now);
    const other = 'https://help.kusto.windows.net/.default';

    const a = await cred.getToken(SCOPE);
    const b = await cred.getToken(other);
    expect(a?.token).not.toBe(b?.token);
    expect((await cred.getToken(SCOPE))?.token).toBe(a?.token);
    expect((await cred.getToken(other))?.token).toBe(b?.token);
    expect(inner.getToken).toHaveBeenCalledTimes(2);
  });

  test('claims challenges bypass the cache', async () => {
    const inner = fakeInner(now);
    const cred = new CachingTokenCredential(inner, now);
    await cred.getToken(SCOPE);
    await cred.getToken(SCOPE, { claims: 'c' });
    expect(inner.getToken).toHaveBeenCalledTimes(2);
  });

  test('a claims challenge replaces the rejected cached token', async () => {
    const inner = fakeInner(now);
    const cred = new CachingTokenCredential(inner, now);
    expect((await cred.getToken(SCOPE))?.token).toBe('t1');
    expect((await cred.getToken(SCOPE, { claims: 'c' }))?.token).toBe('t2');
    expect((await cred.getToken(SCOPE))?.token).toBe('t2');
    expect(inner.getToken).toHaveBeenCalledTimes(2);
  });

  test('a late ordinary fetch cannot overwrite the claims token', async () => {
    const releases: Array<(t: AccessToken) => void> = [];
    const inner = {
      getToken: jest.fn(
        () => new Promise<AccessToken>(resolve => releases.push(resolve)),
      ),
    };
    const cred = new CachingTokenCredential(inner, now);
    const ordinary = cred.getToken(SCOPE);
    const claims = cred.getToken(SCOPE, { claims: 'c' });
    // An ordinary caller arriving during the claims refresh joins it.
    const joiner = cred.getToken(SCOPE);
    expect(inner.getToken).toHaveBeenCalledTimes(2);

    releases[1]({ token: 'fresh', expiresOnTimestamp: clock + HOUR });
    expect((await claims)?.token).toBe('fresh');
    expect((await joiner)?.token).toBe('fresh');
    releases[0]({ token: 'rejected', expiresOnTimestamp: clock + HOUR });
    expect((await ordinary)?.token).toBe('rejected');

    expect((await cred.getToken(SCOPE))?.token).toBe('fresh');
    expect(inner.getToken).toHaveBeenCalledTimes(2);
  });

  test('CAE and non-CAE tokens are cached separately', async () => {
    const inner = fakeInner(now);
    const cred = new CachingTokenCredential(inner, now);
    expect((await cred.getToken(SCOPE, { enableCae: false }))?.token).toBe(
      't1',
    );
    expect((await cred.getToken(SCOPE, { enableCae: true }))?.token).toBe('t2');
    expect(inner.getToken).toHaveBeenCalledTimes(2);
  });

  test('honors refreshAfterTimestamp before the expiry margin', async () => {
    let n = 0;
    const inner = {
      getToken: jest.fn(async () => ({
        token: `r${++n}`,
        expiresOnTimestamp: clock + HOUR,
        refreshAfterTimestamp: clock + 10 * 60 * 1000,
      })),
    };
    const cred = new CachingTokenCredential(inner, now);
    expect((await cred.getToken(SCOPE))?.token).toBe('r1');
    clock += 10 * 60 * 1000 - 1;
    expect((await cred.getToken(SCOPE))?.token).toBe('r1');
    clock += 1;
    expect((await cred.getToken(SCOPE))?.token).toBe('r2');
    expect(inner.getToken).toHaveBeenCalledTimes(2);
  });

  test("one caller's abort rejects only that caller", async () => {
    let release!: (t: AccessToken) => void;
    const inner = {
      getToken: jest.fn(
        () => new Promise<AccessToken>(resolve => (release = resolve)),
      ),
    };
    const cred = new CachingTokenCredential(inner, now);
    const controller = new AbortController();

    const aborted = cred.getToken(SCOPE, { abortSignal: controller.signal });
    const other = cred.getToken(SCOPE);
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });

    release({ token: 'late', expiresOnTimestamp: clock + HOUR });
    expect((await other)?.token).toBe('late');
    expect(inner.getToken).toHaveBeenCalledTimes(1);
    // The inner request never sees a caller's signal, and isn't cancelled
    // while another caller still waits on it.
    const innerSignal = (
      inner.getToken.mock.calls[0] as unknown[]
    )[1] as { abortSignal: AbortSignal };
    expect(innerSignal.abortSignal).not.toBe(controller.signal);
    expect(innerSignal.abortSignal.aborted).toBe(false);
  });

  test('an already-aborted signal rejects without calling through', async () => {
    const inner = fakeInner(now);
    const cred = new CachingTokenCredential(inner, now);
    const controller = new AbortController();
    controller.abort();
    await expect(
      cred.getToken(SCOPE, { abortSignal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(inner.getToken).not.toHaveBeenCalled();
  });

  describe('cancels the inner fetch once every caller abandons it (#346)', () => {
    /** Inner credential that waits for release() and records its signal. */
    function pendingInner() {
      const releases: Array<(t: AccessToken) => void> = [];
      const signals: AbortSignal[] = [];
      const getToken = jest.fn(
        (_s: string | string[], o?: { abortSignal?: AbortSignal }) => {
          signals.push(o!.abortSignal!);
          return new Promise<AccessToken>(resolve => releases.push(resolve));
        },
      );
      return { inner: { getToken }, releases, signals };
    }

    test('a single caller aborting aborts the inner fetch', async () => {
      const { inner, signals } = pendingInner();
      const cred = new CachingTokenCredential(inner, now);
      const ac = new AbortController();
      const p = cred.getToken(SCOPE, { abortSignal: ac.signal });
      expect(signals[0].aborted).toBe(false);
      ac.abort();
      await expect(p).rejects.toMatchObject({ name: 'AbortError' });
      expect(signals[0].aborted).toBe(true);
    });

    test('one of two callers aborting leaves the fetch running', async () => {
      const { inner, releases, signals } = pendingInner();
      const cred = new CachingTokenCredential(inner, now);
      const a = new AbortController();
      const b = new AbortController();
      const pa = cred.getToken(SCOPE, { abortSignal: a.signal });
      const pb = cred.getToken(SCOPE, { abortSignal: b.signal });
      a.abort();
      await expect(pa).rejects.toMatchObject({ name: 'AbortError' });
      expect(signals[0].aborted).toBe(false);
      releases[0]({ token: 'ok', expiresOnTimestamp: clock + HOUR });
      expect((await pb)?.token).toBe('ok');
      expect(inner.getToken).toHaveBeenCalledTimes(1);
    });

    test('both callers aborting aborts the inner fetch', async () => {
      const { inner, signals } = pendingInner();
      const cred = new CachingTokenCredential(inner, now);
      const a = new AbortController();
      const b = new AbortController();
      const pa = cred.getToken(SCOPE, { abortSignal: a.signal });
      const pb = cred.getToken(SCOPE, { abortSignal: b.signal });
      a.abort();
      expect(signals[0].aborted).toBe(false);
      b.abort();
      await expect(pa).rejects.toMatchObject({ name: 'AbortError' });
      await expect(pb).rejects.toMatchObject({ name: 'AbortError' });
      expect(signals[0].aborted).toBe(true);
    });

    test('a caller without a signal pins the fetch', async () => {
      const { inner, releases, signals } = pendingInner();
      const cred = new CachingTokenCredential(inner, now);
      const ac = new AbortController();
      const pinned = cred.getToken(SCOPE);
      const aborting = cred.getToken(SCOPE, { abortSignal: ac.signal });
      ac.abort();
      await expect(aborting).rejects.toMatchObject({ name: 'AbortError' });
      expect(signals[0].aborted).toBe(false);
      releases[0]({ token: 'ok', expiresOnTimestamp: clock + HOUR });
      expect((await pinned)?.token).toBe('ok');
    });

    test('a cancelled fetch is never cached; the next call refetches', async () => {
      const { inner, releases } = pendingInner();
      const cred = new CachingTokenCredential(inner, now);
      const ac = new AbortController();
      const p = cred.getToken(SCOPE, { abortSignal: ac.signal });
      ac.abort();
      await expect(p).rejects.toMatchObject({ name: 'AbortError' });
      // The inner credential ignores the abort and resolves anyway.
      releases[0]({ token: 'abandoned', expiresOnTimestamp: clock + HOUR });
      await new Promise(r => setImmediate(r));

      const next = cred.getToken(SCOPE);
      expect(inner.getToken).toHaveBeenCalledTimes(2);
      releases[1]({ token: 'fresh', expiresOnTimestamp: clock + HOUR });
      expect((await next)?.token).toBe('fresh');
      expect((await cred.getToken(SCOPE))?.token).toBe('fresh');
      expect(inner.getToken).toHaveBeenCalledTimes(2);
    });
  });
});

describe('createTokenCredential', () => {
  test.each(['azure-cli', 'azure-identity'])(
    '%s returns a caching credential',
    method => {
      expect(createTokenCredential(method)).toBeInstanceOf(
        CachingTokenCredential,
      );
    },
  );
});
