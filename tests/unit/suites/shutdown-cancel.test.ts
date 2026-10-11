/**
 * #333 — when the stdio client disconnects, an in-flight execute-query must
 * not be left running on the cluster. Shutdown closes the MCP server (the SDK
 * then aborts in-flight handlers, which send `.cancel query`), waits a bounded
 * time for those cancels, then exits.
 *
 * Shutdown is crash-path code (#180/#196): it must never throw and must exit
 * within its cap even when a step never settles.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client as KustoClient } from 'azure-kusto-data';
import {
  CANCEL_DRAIN_CAP_MS,
  createShutdown,
  pendingCancelCount,
  settlePendingCancels,
  trackPendingCancel,
} from '../../../src/common/shutdown.js';
import { createKustoServer } from '../../../src/server.js';
import { AuthenticationMethod } from '../../../src/types/config.js';

jest.mock('../../../src/common/version.js', () => ({ VERSION: '0.0.0-test' }));

type Call = { query: string; props?: { clientRequestId?: string | null } };

const ok = { primaryResults: [{ name: 'r', columns: [], _rows: [] }] };
const never = () => new Promise<never>(() => {});

function routeKusto(cancel: () => Promise<unknown>) {
  const calls: Call[] = [];
  jest
    .spyOn(KustoClient.prototype, 'execute')
    .mockImplementation(
      async (_db: string | null, q: string, props?: unknown) => {
        calls.push({ query: q, props: props as Call['props'] });
        if (q === 'print now()') return ok as never;
        if (q.startsWith('.cancel query')) return cancel() as never;
        return never() as never;
      },
    );
  return calls;
}

async function waitFor(cond: () => boolean, ms = 1000) {
  const until = Date.now() + ms;
  while (!cond() && Date.now() < until) {
    await new Promise(r => setTimeout(r, 10));
  }
}

/** A connected server with one execute-query stuck on the cluster. */
async function serverWithRunningQuery(calls: Call[]) {
  const server = createKustoServer({
    authMethod: AuthenticationMethod.AzureCli,
    queryTimeout: 60000,
  });
  const client = new Client({ name: 'unit-test', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  await client.callTool({
    name: 'initialize-connection',
    arguments: { cluster_url: 'https://x.kusto.windows.net', database: 'd' },
  });
  const pending = client
    .callTool({ name: 'execute-query', arguments: { query: 'T | count' } })
    .catch(() => {});
  await waitFor(() => calls.some(c => c.query.startsWith('T | count')));
  return { server, client, pending };
}

function steps(overrides: Partial<Parameters<typeof createShutdown>[0]> = {}) {
  const events: string[] = [];
  const exit = jest.fn((code: number) => {
    events.push(`exit:${code}`);
  });
  return {
    events,
    exit,
    shutdown: createShutdown({
      closeServer: async () => {},
      drainCancels: async () => {},
      flushTelemetry: async () => {
        events.push('flush');
      },
      exit,
      log: () => {},
      ...overrides,
    }),
  };
}

describe('shutdown cancels in-flight queries (#333)', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);

  beforeAll(() => process.on('unhandledRejection', onUnhandled));
  afterAll(() => process.off('unhandledRejection', onUnhandled));
  beforeEach(() => {
    unhandled.length = 0;
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test('client disconnect sends .cancel query and lets it reach the cluster before exit', async () => {
    const events: string[] = [];
    const calls = routeKusto(async () => {
      await new Promise(r => setTimeout(r, 100));
      events.push('cancel-delivered');
      return ok;
    });
    const { server, client, pending } = await serverWithRunningQuery(calls);
    try {
      const exit = jest.fn((code: number) => {
        events.push(`exit:${code}`);
      });
      const shutdown = createShutdown({
        closeServer: () => server.close(),
        drainCancels: settlePendingCancels,
        flushTelemetry: async () => {
          events.push('flush');
        },
        exit,
        log: () => {},
      });

      await shutdown('client-disconnect');

      const requestId = calls.find(c => c.query.startsWith('T | count'))!.props
        ?.clientRequestId;
      expect(calls.map(c => c.query)).toContain(`.cancel query "${requestId}"`);
      expect(events).toEqual(['cancel-delivered', 'flush', 'exit:0']);
      expect(pendingCancelCount()).toBe(0);
    } finally {
      await client.close().catch(() => {});
      await pending;
    }
  });

  test('exits within the cap even if the .cancel query never settles', async () => {
    const calls = routeKusto(never);
    const { server, client, pending } = await serverWithRunningQuery(calls);
    try {
      const { shutdown, exit, events } = steps({
        closeServer: () => server.close(),
        drainCancels: settlePendingCancels,
        drainCapMs: 200,
      });

      const started = Date.now();
      await shutdown('client-disconnect');
      const elapsed = Date.now() - started;

      expect(calls.some(c => c.query.startsWith('.cancel query'))).toBe(true);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(events).toEqual(['flush', 'exit:0']);
      expect(elapsed).toBeGreaterThanOrEqual(150);
      expect(elapsed).toBeLessThan(1000);
    } finally {
      await client.close().catch(() => {});
      await pending;
    }
  });

  test('the default cap bounds a cancel that never settles', async () => {
    jest.useFakeTimers();
    trackPendingCancel(never());
    const { shutdown, exit } = steps({ drainCancels: settlePendingCancels });

    const done = shutdown('client-disconnect');
    await jest.advanceTimersByTimeAsync(CANCEL_DRAIN_CAP_MS - 1);
    expect(exit).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await done;

    expect(exit).toHaveBeenCalledWith(0);
    expect(CANCEL_DRAIN_CAP_MS).toBeLessThanOrEqual(2000);
  });

  test('a server close that hangs still exits within the cap', async () => {
    const { shutdown, exit } = steps({ closeServer: never, drainCapMs: 50 });
    await shutdown('client-disconnect');
    expect(exit).toHaveBeenCalledWith(0);
  });

  test('never throws: failing steps still exit with the requested code', async () => {
    const { shutdown, exit } = steps({
      closeServer: () => {
        throw new Error('close failed');
      },
      drainCancels: async () => {
        throw new Error('drain failed');
      },
      flushTelemetry: () => {
        throw new Error('telemetry never started');
      },
      log: () => {
        throw new Error('write EPIPE');
      },
    });

    await expect(shutdown('uncaughtException', 1)).resolves.toBeUndefined();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(unhandled).toEqual([]);
  });

  test('a rejected flush still exits', async () => {
    const { shutdown, exit } = steps({
      flushTelemetry: async () => {
        throw new Error('flush failed');
      },
    });
    await shutdown('SIGTERM');
    expect(exit).toHaveBeenCalledWith(0);
  });

  test('repeat triggers (stdin end + close + transport close) exit once', async () => {
    const { shutdown, exit } = steps();
    await Promise.all([
      shutdown('client-disconnect'),
      shutdown('client-disconnect'),
      shutdown('SIGINT'),
    ]);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  test('a failed .cancel query is dropped from tracking without an unhandled rejection', async () => {
    // Earlier tests leave never-settling cancels behind on purpose.
    const before = pendingCancelCount();
    trackPendingCancel(Promise.reject(new Error('cancel failed')));
    expect(pendingCancelCount()).toBe(before + 1);
    await new Promise(r => setTimeout(r, 10));
    expect(pendingCancelCount()).toBe(before);
    expect(unhandled).toEqual([]);
  });
});
