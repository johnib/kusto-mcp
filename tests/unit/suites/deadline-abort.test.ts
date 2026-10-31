/**
 * The connect deadline cancels the token fetch. Before, the token request
 * carried no abort signal, so the cache pinned the fetch and a hung `az` kept
 * running past the deadline (until its own kill timer, set to the same 20s).
 * Now the deadline aborts the request; the cache cancels the inner fetch,
 * which kills the `az` process tree (#346). That includes the one tenant
 * fallback fetch after a 401.
 */
const signals: AbortSignal[] = [];
const deadlines: (number | undefined)[] = [];
let tokensBeforeHang = 0;
let metadataDelayMs = 0;
// The SDK asks the credential itself during validation, and tokens are
// short-lived (inside the cache's refresh margin), so that request misses.
let sdkAsksForToken = false;
let tokenLifetimeMs = 3600_000;
// After the answered tokens, fail instead of hang.
let tokenError: Error | undefined;
jest.mock('../../../src/auth/az-cli-credential.js', () => ({
  AzCliCredential: class AzCliCredential {
    readonly allowsSubscriptionTenant = true;
    getToken(
      _s: unknown,
      options?: { abortSignal?: AbortSignal; kustoMcpAzDeadlineAt?: number },
    ) {
      if (options?.abortSignal) signals.push(options.abortSignal);
      deadlines.push(options?.kustoMcpAzDeadlineAt);
      if (tokensBeforeHang > 0) {
        tokensBeforeHang--;
        const b64 = (o: unknown) =>
          Buffer.from(JSON.stringify(o)).toString('base64url');
        return Promise.resolve({
          token: `${b64({})}.${b64({ tid: 't', oid: 'o' })}.s`,
          expiresOnTimestamp: Date.now() + tokenLifetimeMs,
        });
      }
      if (tokenError) return Promise.reject(tokenError);
      return new Promise(() => {});
    }
  },
}));

const execute = jest.fn();
jest.mock('azure-kusto-data', () => ({
  CloudSettings: {
    getCloudInfoForCluster: async () => {
      if (metadataDelayMs)
        await new Promise(r => setTimeout(r, metadataDelayMs));
      return {
        KustoServiceResourceId: 'https://kusto.kusto.windows.net',
        LoginMfaRequired: false,
      };
    },
  },
  KustoConnectionStringBuilder: {
    withTokenCredential: (_u: string, credential: unknown) => ({ credential }),
  },
  Client: class {
    constructor(
      private cs: {
        credential: { getToken: (s: string[]) => Promise<unknown> };
      },
    ) {}
    async execute() {
      if (sdkAsksForToken)
        await this.cs.credential.getToken([
          'https://kusto.kusto.windows.net/.default',
        ]);
      return execute();
    }
    close() {}
  },
  ClientRequestProperties: class {
    setClientTimeout() {}
  },
}));

import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { KustoConnection } from '../../../src/operations/kusto/connection.js';
import { AuthenticationMethod } from '../../../src/types/config.js';

const connect = (connectionTimeout: number) =>
  new KustoConnection({
    authMethod: AuthenticationMethod.AzureCli,
    connectionTimeout,
  })
    .initialize('https://acme.kusto.windows.net', 'db')
    .then(
      () => new Error('connected'),
      (e: Error) => e,
    );

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
beforeAll(() => provider.register());
const initSpan = () =>
  exporter.getFinishedSpans().find(s => s.name === 'mcp.connection.init')!
    .attributes;

beforeEach(() => {
  exporter.reset();
  signals.length = 0;
  deadlines.length = 0;
  metadataDelayMs = 0;
  sdkAsksForToken = false;
  tokenLifetimeMs = 3600_000;
  tokenError = undefined;
  tokensBeforeHang = 0;
  execute.mockReset();
});

test('a token request still running at the deadline is aborted', async () => {
  const err = await connect(50);
  expect(err.message).toMatch(/timed out after 50ms/);
  expect(signals).toHaveLength(1);
  expect(signals[0].aborted).toBe(true);
});

test('the tenant fallback fetch after a 401 is aborted at the deadline too', async () => {
  tokensBeforeHang = 1;
  execute.mockRejectedValue(
    Object.assign(new Error('401'), { response: { status: 401 } }),
  );
  const err = await connect(200);
  expect(err.message).toMatch(/timed out after 200ms/);
  // First fetch answered; the fallback fetch hung and got the abort.
  expect(signals).toHaveLength(2);
  expect(signals[1].aborted).toBe(true);
  // No validation query after the abandoned fallback.
  expect(execute).toHaveBeenCalledTimes(1);
});

test('the token request carries the absolute connect deadline, after slow metadata too', async () => {
  metadataDelayMs = 300;
  const started = Date.now();
  await connect(1000);
  expect(deadlines).toHaveLength(1);
  // The deadline itself (started + 1000), not a fresh 1000ms from the
  // token step: az measures what is left when it spawns.
  expect(deadlines[0]! - started).toBeGreaterThanOrEqual(1000);
  expect(deadlines[0]! - started).toBeLessThan(1100);
});

test("a joined fetch that az timed out on its starter's deadline is retried on the joiner's", async () => {
  const { CachingTokenCredential } = jest.requireActual(
    '../../../src/auth/token-credentials.js',
  );
  let calls = 0;
  let failFirst!: (e: unknown) => void;
  const inner = {
    getToken: () => {
      calls++;
      if (calls === 1)
        return new Promise((_, reject) => {
          failFirst = reject;
        });
      return Promise.resolve({
        token: 'second',
        expiresOnTimestamp: Date.now() + 3600_000,
      });
    },
  };
  const cache = new CachingTokenCredential(inner);
  const starter = cache.getToken('s', {
    kustoMcpAzDeadlineAt: Date.now() + 500,
  });
  const joiner = cache.getToken('s', {
    kustoMcpAzDeadlineAt: Date.now() + 10_000,
  });
  failFirst(Object.assign(new Error('az timed out'), { azReason: 'timeout' }));
  await expect(starter).rejects.toMatchObject({ azReason: 'timeout' });
  await expect(joiner).resolves.toMatchObject({ token: 'second' });
  expect(calls).toBe(2);
});

test("the SDK's own token request during validation is bounded by the deadline too", async () => {
  // Our fetch answers with a token inside the refresh margin; the SDK's
  // request then misses the cache and its fetch hangs.
  tokensBeforeHang = 1;
  tokenLifetimeMs = 60_000;
  sdkAsksForToken = true;
  const err = await connect(200);
  expect(err.message).toMatch(/timed out after 200ms/);
  expect(signals).toHaveLength(2);
  expect(signals[1].aborted).toBe(true);
  expect(deadlines[1]).toBe(deadlines[0]);
  // The attempt waited on that token, not on the cluster.
  expect(err.message).toMatch(/Failed step: getting an Azure token/);
  expect(err.message).toMatch(/No token within/);
  expect(initSpan()['kustomcp.connection.failed_step']).toBe('token');
  expect(initSpan()['kustomcp.connection.failure_category']).toBe('timeout');
});

test("an az timeout on the SDK's validation request is a token failure, not a cluster one", async () => {
  tokensBeforeHang = 1;
  tokenLifetimeMs = 60_000;
  sdkAsksForToken = true;
  tokenError = Object.assign(new Error('az timed out'), {
    name: 'AzCliDeadlineError',
    azReason: 'timeout',
  });
  const err = await connect(5000);
  expect(err.message).toMatch(/Failed step: getting an Azure token/);
  expect(err.message).not.toMatch(/reaching the cluster/);
  const attrs = initSpan();
  expect(attrs['kustomcp.connection.failed_step']).toBe('token');
  expect(attrs['kustomcp.connection.failure_category']).toBe('auth');
  expect(attrs['kustomcp.connection.outcome']).toBe('auth_error');
  expect(attrs['kustomcp.auth.az_reason']).toBe('timeout');
});
