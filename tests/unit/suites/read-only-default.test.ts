/**
 * Read-only is the default (#323): write/management commands are blocked
 * unless KUSTO_ALLOW_WRITE_OPERATIONS opts in.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { parseAllowWriteOperations } from '../../../src/common/env-config.js';
import { createKustoServer } from '../../../src/server.js';
import {
  DEFAULT_CONFIG,
  KustoConfig,
  validateConfig,
} from '../../../src/types/config.js';
import { executeQuery } from '../../../src/operations/kusto/index.js';

jest.mock('../../../src/common/version.js', () => ({ VERSION: '0.0.0-test' }));

jest.mock('../../../src/operations/kusto/index.js', () => {
  const actual = jest.requireActual('../../../src/operations/kusto/index.js');
  return {
    ...actual,
    KustoConnection: jest.fn().mockImplementation(() => ({
      initialize: async () => ({ cluster: 'c', database: 'd' }),
    })),
    executeQuery: jest.fn(async () => ({
      primaryResults: [
        { name: 'r', columns: [{ ColumnName: 'a' }], _rows: [[1]] },
      ],
    })),
  };
});

const WRITE_COMMAND =
  ".create-or-alter function with (folder='x') kmcp_test() { print 1 }";

describe('read-only by default', () => {
  test('default config is read-only', () => {
    expect(DEFAULT_CONFIG.allowWriteOperations).toBe(false);
    expect(validateConfig({}).allowWriteOperations).toBe(false);
  });

  describe('parseAllowWriteOperations', () => {
    test.each([
      'true',
      'TRUE',
      'True',
      '1',
      'yes',
      'YES',
      'on',
      'On',
      ' true ',
      'true # allow writes',
    ])('%p allows writes', value => {
      expect(parseAllowWriteOperations(value)).toBe(true);
    });

    test.each([
      undefined,
      '',
      '   ',
      'false',
      'FALSE',
      '0',
      'no',
      'off',
      'n',
      'disabled',
      'garbage',
      'truthy',
      '2',
      '# true',
    ])('%p keeps the server read-only', value => {
      expect(parseAllowWriteOperations(value)).toBe(false);
    });
  });

  describe('execute-query gate', () => {
    async function connect(config: KustoConfig) {
      const server = createKustoServer(config);
      const client = new Client({ name: 'unit-test', version: '0.0.0' });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(st), client.connect(ct)]);
      await client.callTool({
        name: 'initialize-connection',
        arguments: {
          cluster_url: 'https://x.kusto.windows.net',
          database: 'd',
        },
      });
      return {
        run: (query: string) =>
          client.callTool({ name: 'execute-query', arguments: { query } }),
        close: async () => {
          await client.close();
          await server.close();
        },
      };
    }

    const executeQueryMock = executeQuery as jest.Mock;
    beforeEach(() => executeQueryMock.mockClear());

    test('blocks a write command when no write setting is given', async () => {
      const { run, close } = await connect({});
      try {
        const r = await run(WRITE_COMMAND);
        expect(r.isError).toBe(true);
        expect(JSON.stringify(r.content)).toContain(
          'KUSTO_ALLOW_WRITE_OPERATIONS=true',
        );
        expect(executeQueryMock).not.toHaveBeenCalled();
      } finally {
        await close();
      }
    });

    test('still allows .show and plain KQL by default', async () => {
      const { run, close } = await connect({});
      try {
        expect((await run('.show tables')).isError).toBeFalsy();
        expect((await run('T | take 1')).isError).toBeFalsy();
        expect(executeQueryMock).toHaveBeenCalledTimes(2);
      } finally {
        await close();
      }
    });

    test('lets a write command through when writes are opted in', async () => {
      const { run, close } = await connect({ allowWriteOperations: true });
      try {
        const r = await run(WRITE_COMMAND);
        expect(r.isError).toBeFalsy();
        expect(executeQueryMock).toHaveBeenCalledTimes(1);
        expect(executeQueryMock.mock.calls[0][1]).toBe(WRITE_COMMAND);
      } finally {
        await close();
      }
    });
  });
});
