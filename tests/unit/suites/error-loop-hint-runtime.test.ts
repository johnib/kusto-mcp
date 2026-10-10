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
