/**
 * #346: the default `azure-identity` path must be the SDK's own
 * DefaultAzureCredential with ONLY its Azure CLI step swapped for our
 * tree-killing AzCliCredential. Runs against the installed @azure/identity,
 * so an SDK upgrade that changes the chain shape fails here first.
 *
 * Only process launching is mocked (@azure/core-process): no real az, pwsh
 * or azd runs. Behavior tests use AZURE_TOKEN_CREDENTIALS=dev so the
 * managed-identity probe never touches the network.
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';

jest.unmock('@azure/identity');
jest.unmock('../../../src/auth/az-cli-credential.js');

const spawnMock = jest.fn();
const execFileMock = jest.fn();
jest.mock('@azure/core-process', () => {
  const actual = jest.requireActual('@azure/core-process');
  return {
    ...actual,
    spawn: (...a: unknown[]) => spawnMock(...a),
    execFile: (...a: unknown[]) => execFileMock(...a),
  };
});

import {
  AzureCliCredential,
  AzurePowerShellCredential,
  DefaultAzureCredential,
  GetTokenOptions,
} from '@azure/identity';
import { AzCliCredential } from '../../../src/auth/az-cli-credential.js';
import { SUBSCRIPTION_TENANT } from '../../../src/auth/subscription-tenant.js';
import {
  CachingTokenCredential,
  createTokenCredential,
  withTreeKillingAzCli,
} from '../../../src/auth/token-credentials.js';

const SCOPE = 'https://help.kusto.windows.net/.default';
const ENV_KEYS = [
  'AZURE_TOKEN_CREDENTIALS',
  'AZURE_CLIENT_ID',
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_FEDERATED_TOKEN_FILE',
  'AZURE_USERNAME',
  'AZURE_PASSWORD',
];
let savedEnv: Record<string, string | undefined>;

// createTokenCredential wraps the chain in the token cache (#296); look inside it.
function sources(cred: unknown): unknown[] {
  const chain =
    cred instanceof CachingTokenCredential
      ? (cred as unknown as { inner: unknown }).inner
      : cred;
  return (chain as { _sources: unknown[] })._sources;
}
function names(cred: unknown): string[] {
  return sources(cred).map(s => (s as object).constructor.name);
}

class FakeChild extends EventEmitter {
  pid = 777;
  stdout = Object.assign(new EventEmitter(), { setEncoding: jest.fn() });
  stderr = Object.assign(new EventEmitter(), { setEncoding: jest.fn() });
  kill = jest.fn();
}

/** Make our az exit with the given result on the next spawn. */
function azExits(code: number, stdout = '', stderr = '') {
  spawnMock.mockImplementation(() => {
    const child = new FakeChild();
    setImmediate(() => {
      if (stdout) child.stdout.emit('data', stdout);
      if (stderr) child.stderr.emit('data', stderr);
      child.emit('close', code);
    });
    return child;
  });
}

/** pwsh / azd are "not installed", like a machine without them. */
function sdkProcessesMissing() {
  const { ProcessError } = jest.requireActual('@azure/core-process');
  execFileMock.mockImplementation(async () => {
    throw new ProcessError('The executable could not be found.', {
      code: 'ENOENT',
    });
  });
}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  spawnMock.mockReset();
  execFileMock.mockReset();
  sdkProcessesMissing();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('chain shape matches DefaultAzureCredential', () => {
  test.each([
    ['default (unset)', undefined],
    ['dev', 'dev'],
    ['prod', 'prod'],
    ['AzureCliCredential only', 'AzureCliCredential'],
    ['ManagedIdentityCredential only', 'ManagedIdentityCredential'],
  ])('AZURE_TOKEN_CREDENTIALS=%s: same steps, CLI swapped', (_label, value) => {
    if (value !== undefined) process.env.AZURE_TOKEN_CREDENTIALS = value;
    const sdk = new DefaultAzureCredential({ processTimeoutInMs: 1500 });
    const ours = createTokenCredential('azure-identity', 1500);
    expect(ours).toBeInstanceOf(CachingTokenCredential);
    expect((ours as unknown as { inner: unknown }).inner).toBeInstanceOf(
      DefaultAzureCredential,
    );
    expect(names(ours)).toEqual(
      names(sdk).map(n => (n === 'AzureCliCredential' ? 'AzCliCredential' : n)),
    );
    expect(sources(ours).some(s => s instanceof AzureCliCredential)).toBe(
      false,
    );
  });

  test('default order is the SDK order with our CLI in the CLI slot', () => {
    const ours = createTokenCredential('azure-identity', 1500);
    // Without their env vars the SDK puts a placeholder in the workload
    // identity and broker slots; the order is still DAC's.
    expect(
      names(ours).map(n => (n === 'UnavailableDefaultCredential' ? '-' : n)),
    ).toEqual([
      'EnvironmentCredential',
      '-',
      'ManagedIdentityCredential',
      'VisualStudioCodeCredential',
      'AzCliCredential',
      'AzurePowerShellCredential',
      'AzureDeveloperCliCredential',
      '-',
    ]);
  });

  test('env-driven steps (managed identity client id, tenant) are the SDK-built objects', () => {
    process.env.AZURE_CLIENT_ID = '00000000-0000-0000-0000-000000000001';
    process.env.AZURE_TENANT_ID = '00000000-0000-0000-0000-000000000002';
    const sdk = new DefaultAzureCredential({ processTimeoutInMs: 1500 });
    const ours = createTokenCredential('azure-identity', 1500);
    // Every non-CLI step has the same class and the same own config as DAC's.
    sources(sdk).forEach((s, i) => {
      if (s instanceof AzureCliCredential) return;
      const o = sources(ours)[i] as object;
      expect(o.constructor).toBe((s as object).constructor);
      expect(JSON.stringify(Object.keys(o).sort())).toBe(
        JSON.stringify(Object.keys(s as object).sort()),
      );
    });
  });

  test('an invalid AZURE_TOKEN_CREDENTIALS fails every request, never widens the chain', async () => {
    process.env.AZURE_TOKEN_CREDENTIALS = 'bogus';
    // The SDK itself still throws in its constructor...
    expect(() => new DefaultAzureCredential()).toThrow(
      /AZURE_TOKEN_CREDENTIALS/,
    );
    // ...ours builds, so the connect can report it, but signs nobody in.
    const ours = createTokenCredential('azure-identity', 1500);
    expect(sources(ours)).toBeUndefined(); // no chain at all
    await expect(
      ours.getToken('https://kusto.kusto.windows.net/.default'),
    ).rejects.toThrow(/AZURE_TOKEN_CREDENTIALS="bogus" is not valid/);
    expect(process.env.AZURE_TOKEN_CREDENTIALS).toBe('bogus');
  });

  test('process timeout: our CLI gets it, PowerShell keeps the SDK one', () => {
    const ours = createTokenCredential('azure-identity', 1500);
    const cli = sources(ours).find(s => s instanceof AzCliCredential);
    expect((cli as unknown as { timeoutMs: number }).timeoutMs).toBe(1500);
    const pwsh = sources(ours).find(
      s => s instanceof AzurePowerShellCredential,
    );
    expect((pwsh as unknown as { timeout: number }).timeout).toBe(1500);
  });

  test('an unrecognized credential is returned unchanged', () => {
    const other = { getToken: jest.fn() };
    expect(withTreeKillingAzCli(other)).toBe(other);
  });

  test('@azure/identity is pinned to the version these tests ran against', () => {
    // The swap reads DefaultAzureCredential's private `_sources`. A range
    // would let npx users resolve an untested minor where the swap silently
    // stops; with an exact pin every bump must pass this suite first.
    const read = (p: string) =>
      JSON.parse(readFileSync(path.join(process.cwd(), p), 'utf8'));
    const declared = read('package.json').dependencies['@azure/identity'];
    const installed = read('node_modules/@azure/identity/package.json').version;
    expect(declared).toBe(installed);
  });
});

describe('chain behavior (AZURE_TOKEN_CREDENTIALS=dev)', () => {
  beforeEach(() => {
    process.env.AZURE_TOKEN_CREDENTIALS = 'dev';
  });

  test('our az supplies the token; later steps never run', async () => {
    azExits(0, JSON.stringify({ accessToken: 'tok', expires_on: 1900000000 }));
    const cred = createTokenCredential('azure-identity', 1500);
    await expect(cred.getToken(SCOPE)).resolves.toMatchObject({
      token: 'tok',
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][0]).toBe('az');
    expect(execFileMock).not.toHaveBeenCalled();
  });

  test('az unavailable falls through to PowerShell/azd, then aggregates', async () => {
    azExits(1, '', "ERROR: Please run 'az login' to setup account.");
    const cred = createTokenCredential('azure-identity', 1500);
    const err = await cred.getToken(SCOPE).catch(e => e);
    expect(err.name).toBe('AggregateAuthenticationError');
    const inner = (err.errors as Error[]).map(e => e.name);
    expect(inner.every(n => n === 'CredentialUnavailableError')).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // PowerShell and azd were still tried after our CLI step.
    const tried = execFileMock.mock.calls.map(c => c[0]);
    expect(tried).toEqual(expect.arrayContaining(['azd']));
    expect(tried.some(f => /pwsh|powershell/.test(f))).toBe(true);
  });

  test('a hard (non-unavailable) error stops the chain, like DAC', async () => {
    spawnMock.mockImplementation(() => new FakeChild());
    const ac = new AbortController();
    const cred = createTokenCredential('azure-identity', 60000);
    const p = cred.getToken(SCOPE, { abortSignal: ac.signal });
    await new Promise(r => setImmediate(r));
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  test('aborting while our az runs kills its tree and ends the chain', async () => {
    const platform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      spawnMock.mockImplementation(() => new FakeChild());
      const ac = new AbortController();
      const cred = createTokenCredential('azure-identity', 60000);
      const p = cred.getToken(SCOPE, { abortSignal: ac.signal });
      // Earlier chain steps settle asynchronously; wait for our az to start.
      for (let i = 0; i < 50 && !spawnMock.mock.calls.length; i++) {
        await new Promise(r => setImmediate(r));
      }
      expect(spawnMock).toHaveBeenCalledTimes(1);
      ac.abort();
      await expect(p).rejects.toMatchObject({ name: 'AbortError' });
      expect(kill).toHaveBeenCalledWith(-777, 'SIGKILL');
      // Give a still-running chain time to move on to PowerShell / azd.
      for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
      expect(execFileMock).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
      Object.defineProperty(process, 'platform', { value: platform });
    }
  });

  test('a timed-out az falls through (unavailable), and the tree is killed', async () => {
    const child = new FakeChild();
    spawnMock.mockImplementation(() => child);
    const kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      const cred = createTokenCredential('azure-identity', 30);
      const err = await cred.getToken(SCOPE).catch(e => e);
      expect(err.name).toBe('AggregateAuthenticationError');
      if (process.platform !== 'win32') {
        expect(kill).toHaveBeenCalledWith(-777, 'SIGKILL');
      }
    } finally {
      kill.mockRestore();
    }
  });
});

describe('az runs out the connect deadline (real chain)', () => {
  beforeEach(() => {
    process.env.AZURE_TOKEN_CREDENTIALS = 'dev';
  });

  test('the chain stops at az with an az timeout; later steps never run', async () => {
    // az starts and never answers.
    spawnMock.mockImplementation(() => new FakeChild());
    const cred = createTokenCredential('azure-identity', 19000);
    const err = await cred
      .getToken(SCOPE, {
        kustoMcpAzDeadlineAt: Date.now() + 400,
      } as unknown as GetTokenOptions)
      .catch(e => e);
    expect(err).toMatchObject({
      name: 'AzCliDeadlineError',
      azReason: 'timeout',
    });
    // PowerShell / azd were not tried on a spent budget.
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe('the az step tenant', () => {
  beforeEach(() => {
    process.env.AZURE_TOKEN_CREDENTIALS = 'dev';
    azExits(0, JSON.stringify({ accessToken: 'tok', expires_on: 1900000000 }));
  });
  const tenantArgs = () => {
    const args = spawnMock.mock.calls.at(-1)[1] as string[];
    const i = args.indexOf('--tenant');
    return i === -1 ? undefined : args[i + 1];
  };

  test('the default chain asks az for the home tenant (organizations)', async () => {
    await createTokenCredential('azure-identity', 1500).getToken(SCOPE);
    expect(tenantArgs()).toBe('organizations');
  });

  test('a pinned tenant (AZURE_TENANT_ID) is used in both modes and never falls back', async () => {
    process.env.AZURE_TENANT_ID = 'contoso.onmicrosoft.com';
    for (const mode of ['azure-identity', 'azure-cli']) {
      const cred = createTokenCredential(mode, 1500) as CachingTokenCredential;
      await cred.getToken(SCOPE);
      expect(tenantArgs()).toBe('contoso.onmicrosoft.com');
      expect(cred.canUseSubscriptionTenant()).toBe(false);
    }
  });

  test('a subscription-tenant request runs az with no --tenant and leaves the default alone', async () => {
    const cred = createTokenCredential(
      'azure-identity',
      1500,
    ) as CachingTokenCredential;
    expect(cred.canUseSubscriptionTenant()).toBe(true);
    await cred.getToken(SCOPE);
    expect(tenantArgs()).toBe('organizations');
    await cred.getToken(SCOPE, {
      [SUBSCRIPTION_TENANT]: true,
    } as GetTokenOptions);
    expect(tenantArgs()).toBeUndefined();
    // Cached apart: a default request still gets the home-tenant token.
    await cred.getToken(SCOPE);
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });
});
