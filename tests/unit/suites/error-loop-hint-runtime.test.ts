/**
 * #313: connection/auth/throttle failures raised while a query is running
 * reach the server re-wrapped as KustoQueryError, so the server cannot tell
 * them apart by class. They must neither count toward the error-loop hint nor
 * reset an existing KQL-failure streak.
 *
 * Unlike error-loop-hint.test.ts, this runs the real KustoConnection and
 * queries.executeQuery so the wrapping layers are exercised; only the
 * azure-kusto-data Client (mocked in setup.ts) is driven.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client as KustoClient } from 'azure-kusto-data';
import { createKustoServer } from '../../../src/server.js';
import { AuthenticationMethod } from '../../../src/types/config.js';

jest.mock('../../../src/common/version.js', () => ({ VERSION: '0.0.0-test' }));

const HINT =
  'Several queries failed in a row – check the table schema with show-table and simplify the query.';

const execute = jest.spyOn(
  KustoClient.prototype as unknown as { execute: () => Promise<unknown> },
  'execute',
);

const kqlError = () =>
  Object.assign(new Error("Semantic error: 'x' is not a column"), {
    response: { status: 400 },
  });

const nonQueryFailures: Array<[string, () => Error]> = [
  [
    'auth (token expired)',
    () =>
      Object.assign(new Error('token expired'), {
        name: 'KustoAuthenticationError',
      }),
  ],
  [
    'HTTP 401',
    () =>
      Object.assign(new Error('Unauthorized'), { response: { status: 401 } }),
  ],
  [
    'network (ECONNREFUSED)',
    () => Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' }),
  ],
  [
    'DNS (nested cause)',
    () =>
      Object.assign(new Error('getaddrinfo'), {
        cause: { code: 'ENOTFOUND' },
      }),
  ],
  [
    'throttled (429)',
    () => Object.assign(new Error('Too many'), { response: { status: 429 } }),
  ],
  [
    'service unavailable (503)',
    () =>
      Object.assign(new Error('Service Unavailable'), {
        response: { status: 503 },
      }),
  ],
];

describe('error loop hint ignores runtime connection/auth failures', () => {
  beforeEach(() => {
    execute.mockReset();
    execute.mockResolvedValue({ primaryResults: [] });
  });

  async function connect() {
    const server = createKustoServer({
      authMethod: AuthenticationMethod.AzureCli,
    });
    const client = new Client({ name: 'unit-test', version: '0.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    const init = await client.callTool({
      name: 'initialize-connection',
      arguments: { cluster_url: 'https://x.kusto.windows.net', database: 'd' },
    });
    expect(init.isError).toBeFalsy();
    return {
      client,
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  }
  const text = (r: Awaited<ReturnType<Client['callTool']>>) =>
    (r.content as Array<{ type: string; text: string }>)[0].text;

  test.each(nonQueryFailures)(
    '%s neither counts nor resets a KQL streak',
    async (_label, make) => {
      const { client, close } = await connect();
      const call = () =>
        client.callTool({
          name: 'execute-query',
          arguments: { query: 'T | take 1' },
        });
      try {
        execute.mockRejectedValueOnce(kqlError());
        execute.mockRejectedValueOnce(kqlError());
        await call();
        await call();
        for (let i = 0; i < 3; i++) {
          execute.mockRejectedValueOnce(make());
          const r = await call();
          expect(r.isError).toBe(true);
          expect(text(r)).not.toContain(HINT);
        }
        // Streak is still 2, so the next KQL failure is the third in a row.
        execute.mockRejectedValueOnce(kqlError());
        const third = await call();
        expect(text(third).endsWith(`\n${HINT}`)).toBe(true);
      } finally {
        await close();
      }
    },
  );
});

// Timeouts and client cancels come out of the real KustoConnection with their
// own classes (and a not-a-query-fault mark). They must neither count toward
// the streak nor reset it; a timeout carries its own hint instead (#312).
describe('error loop hint ignores runtime timeouts and client cancels', () => {
  beforeEach(() => {
    execute.mockReset();
    execute.mockResolvedValue({ primaryResults: [] });
  });

  async function connect() {
    const server = createKustoServer({
      authMethod: AuthenticationMethod.AzureCli,
      queryTimeout: 30,
    });
    const client = new Client({ name: 'unit-test', version: '0.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    const init = await client.callTool({
      name: 'initialize-connection',
      arguments: { cluster_url: 'https://x.kusto.windows.net', database: 'd' },
    });
    expect(init.isError).toBeFalsy();
    return {
      client,
      close: async () => {
        await client.close();
        await server.close();
      },
    };
  }
  const text = (r: Awaited<ReturnType<Client['callTool']>>) =>
    (r.content as Array<{ type: string; text: string }>)[0].text;
  const hang = () => new Promise<never>(() => {});
  const serverTimeout = () =>
    Object.assign(new Error('Request failed with status code 400'), {
      response: {
        status: 400,
        data: {
          error: {
            code: 'RequestExecutionTimeout',
            '@type': 'Kusto.Data.Exceptions.KustoServiceTimeoutException',
          },
        },
      },
    });

  test.each([
    ['client timeout', () => execute.mockImplementationOnce(hang)],
    ['server timeout', () => execute.mockRejectedValueOnce(serverTimeout())],
  ])('%s neither counts nor resets a KQL streak', async (_label, arm) => {
    const { client, close } = await connect();
    const call = () =>
      client.callTool({
        name: 'execute-query',
        arguments: { query: 'T | take 1' },
      });
    try {
      execute.mockRejectedValueOnce(kqlError());
      await call();
      execute.mockRejectedValueOnce(kqlError());
      await call();
      for (let i = 0; i < 3; i++) {
        arm();
        const r = await call();
        expect(text(r)).toContain('Narrow the time range');
        expect(text(r)).not.toContain(HINT);
      }
      execute.mockRejectedValueOnce(kqlError());
      expect(text(await call()).endsWith(`\n${HINT}`)).toBe(true);
    } finally {
      await close();
    }
  });

  test('client cancel neither counts nor resets a KQL streak', async () => {
    const { client, close } = await connect();
    const call = (signal?: AbortSignal) =>
      client.callTool(
        { name: 'execute-query', arguments: { query: 'T | take 1' } },
        undefined,
        { signal },
      );
    const cancelled = async () => {
      execute.mockImplementationOnce(hang);
      const ac = new AbortController();
      const pending = call(ac.signal);
      // Let the request reach the (hanging) Kusto call, then cancel it.
      await new Promise(r => setTimeout(r, 5));
      ac.abort('user gave up');
      await expect(pending).rejects.toThrow();
      // The server finishes the cancelled call after the client gives up.
      await new Promise(r => setTimeout(r, 20));
    };
    const bad = async () => {
      execute.mockRejectedValueOnce(kqlError());
      return text(await call());
    };
    try {
      // Three cancels do not build a streak.
      for (let i = 0; i < 3; i++) await cancelled();
      expect(await bad()).not.toContain(HINT);
      // A cancel between KQL failures does not reset it either.
      expect(await bad()).not.toContain(HINT);
      await cancelled();
      expect((await bad()).endsWith(`\n${HINT}`)).toBe(true);
    } finally {
      await close();
    }
  });
});
