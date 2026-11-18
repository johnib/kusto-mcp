/**
 * #442: azure-kusto-data's cloud-metadata GET has no timeout, so an
 * unreachable cluster holds the connect deadline in the metadata step. The
 * step stays under that deadline only: telemetry shows working connects with
 * metadata_ms up to 14 s, so a shorter cap would break them. A deadline that
 * fires in this step gives timeout / metadata and a hint that names the
 * network causes.
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

describe('cloud-metadata step under the connect deadline (#442)', () => {
  beforeAll(() => provider.register());
  beforeEach(() => {
    jest.useFakeTimers();
    exporter.reset();
    getToken.mockClear();
    probe.mockClear();
    cloudInfo = () => new Promise(() => {});
  });
  afterEach(() => jest.useRealTimers());

  test('a hung metadata GET fails at the connect deadline with a network hint', async () => {
    const run = start(20000);
    await jest.advanceTimersByTimeAsync(19999);
    expect(run.settled()).toBeUndefined();
    await jest.advanceTimersByTimeAsync(1);
    await run.done;
    const err = run.settled() as Error;
    expect(err).toBeInstanceOf(Error);

    const attrs = initSpan().attributes;
    expect(attrs['kustomcp.connection.failure_category']).toBe('timeout');
    expect(attrs['kustomcp.connection.outcome']).toBe('timeout');
    expect(attrs['kustomcp.connection.failed_step']).toBe('metadata');
    expect(attrs['kustomcp.connection.timed_out']).toBe(true);
    expect(attrs['kustomcp.connection.duration_ms']).toBe(20000);
    // No token request was made, and no probe (the category is known).
    expect(getToken).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    // Telemetry carries no message text or the cluster address.
    for (const v of Object.values(attrs)) {
      if (typeof v === 'string') expect(v).not.toContain('10.255.255.1');
    }

    // The user hint names the likely network causes and the cluster URL.
    expect(err.message).toMatch(/Failed step: reaching the cluster/);
    expect(err.message).toContain(CLUSTER);
    expect(err.message).toMatch(/within 20s/);
    for (const word of [/VPN/, /private endpoint/, /proxy/, /DNS/]) {
      expect(err.message).toMatch(word);
    }
  });

  test('a slow metadata step (8 s) under a 20 s deadline still connects', async () => {
    cloudInfo = () =>
      new Promise(resolve =>
        setTimeout(
          () =>
            resolve({
              KustoServiceResourceId: 'https://kusto.kusto.windows.net',
              LoginMfaRequired: false,
            }),
          8000,
        ),
      );
    const run = start(20000);
    await jest.advanceTimersByTimeAsync(8000);
    await run.done;
    expect(run.settled()).toBe('ok');
    expect(getToken).toHaveBeenCalledTimes(1);
    const attrs = initSpan().attributes;
    expect(attrs['kustomcp.connection.outcome']).toBe('success');
    expect(attrs['kustomcp.connection.metadata_ms']).toBe(8000);
  });
});
