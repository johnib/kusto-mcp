/**
 * #442: azure-kusto-data's cloud-metadata GET has no timeout, so an
 * unreachable cluster held the whole 20 s connect deadline in the metadata
 * step. The step now has its own 5 s limit (never more than what is left of
 * the connect deadline) and fails as timeout / metadata with a hint.
 */
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

let cloudInfo: () => Promise<unknown> = () => new Promise(() => {});
jest.mock('azure-kusto-data', () => ({
  CloudSettings: { getCloudInfoForCluster: () => cloudInfo() },
  KustoConnectionStringBuilder: {
    withTokenCredential: (u: string) => `cs-${u}`,
  },
  Client: class {
    async execute() {
      return {};
    }
    close() {}
  },
  ClientRequestProperties: class {
    setClientTimeout() {}
  },
}));

const getToken = jest.fn(async () => ({
  token: 'mock-token',
  expiresOnTimestamp: Date.now() + 3600_000,
}));
jest.mock('../../../src/auth/token-credentials.js', () => ({
  ...jest.requireActual('../../../src/auth/token-credentials.js'),
  createTokenCredential: jest.fn(() => ({ getToken })),
}));

const probe = jest.fn(async () => undefined);
jest.mock('../../../src/common/connection-hints.js', () => ({
  ...jest.requireActual('../../../src/common/connection-hints.js'),
  probeReachability: (...a: unknown[]) => probe(...(a as [])),
}));

import { KustoConnection } from '../../../src/operations/kusto/connection.js';
import { AuthenticationMethod } from '../../../src/types/config.js';

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
const CLUSTER = 'https://10.255.255.1';

function start(connectionTimeout: number) {
  const conn = new KustoConnection({
    authMethod: AuthenticationMethod.AzureCli,
    connectionTimeout,
  });
  let settled: Error | 'ok' | undefined;
  const done = conn.initialize(CLUSTER, 'db').then(
    () => (settled = 'ok'),
    e => (settled = e as Error),
  );
  return { done, settled: () => settled };
}

function initSpan() {
  return exporter
    .getFinishedSpans()
    .find(s => s.name === 'mcp.connection.init')!;
}

describe('cloud-metadata step has its own limit (#442)', () => {
  beforeAll(() => provider.register());
  beforeEach(() => {
    jest.useFakeTimers();
    exporter.reset();
    getToken.mockClear();
    probe.mockClear();
    cloudInfo = () => new Promise(() => {});
  });
  afterEach(() => jest.useRealTimers());

  test('a hung metadata GET fails after 5 s, not at the 20 s deadline', async () => {
    const run = start(20000);
    await jest.advanceTimersByTimeAsync(4999);
    expect(run.settled()).toBeUndefined();
    await jest.advanceTimersByTimeAsync(1);
    // Settled at 5 s: the old code still waited for the 20 s deadline here.
    const err = run.settled() as Error;
    expect(err).toBeInstanceOf(Error);
    await run.done;

    const attrs = initSpan().attributes;
    expect(attrs['kustomcp.connection.failure_category']).toBe('timeout');
    expect(attrs['kustomcp.connection.outcome']).toBe('timeout');
    expect(attrs['kustomcp.connection.failed_step']).toBe('metadata');
    expect(attrs['kustomcp.connection.timed_out']).toBe(true);
    expect(attrs['kustomcp.connection.duration_ms']).toBe(5000);
    // No token request was made, and no probe (the category is known).
    expect(getToken).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    // Telemetry carries no message text or the cluster address.
    for (const v of Object.values(attrs)) {
      if (typeof v === 'string') expect(v).not.toContain('10.255.255.1');
    }

    // The user hint names the likely causes and the cluster URL.
    expect(err.message).toMatch(/Failed step: reaching the cluster/);
    expect(err.message).toContain(CLUSTER);
    expect(err.message).toMatch(/within 5s/);
    for (const word of [/VPN/, /private endpoint/, /proxy/, /DNS/]) {
      expect(err.message).toMatch(word);
    }
    expect(err.message).not.toMatch(/KUSTO_CONNECTION_TIMEOUT/);
  });

  // Guard, not a regression test: the connect deadline already gave this
  // before #442. It makes sure that the 5 s limit never extends it.
  test('a connect deadline shorter than 5 s still bounds the metadata step', async () => {
    const run = start(2000);
    await jest.advanceTimersByTimeAsync(2000);
    await run.done;
    const err = run.settled() as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/within 2s/);
    const attrs = initSpan().attributes;
    expect(attrs['kustomcp.connection.failed_step']).toBe('metadata');
    expect(attrs['kustomcp.connection.failure_category']).toBe('timeout');
  });

  test('metadata that answers within 5 s continues to the token step', async () => {
    cloudInfo = () =>
      new Promise(resolve =>
        setTimeout(
          () =>
            resolve({
              KustoServiceResourceId: 'https://kusto.kusto.windows.net',
              LoginMfaRequired: false,
            }),
          4000,
        ),
      );
    const run = start(20000);
    await jest.advanceTimersByTimeAsync(4000);
    await run.done;
    expect(run.settled()).toBe('ok');
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(initSpan().attributes['kustomcp.connection.outcome']).toBe(
      'success',
    );
  });
});
