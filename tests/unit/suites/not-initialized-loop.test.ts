/**
 * Regression guards for agents that query before connecting:
 * - with no cluster configured, the execute-query description tells the agent
 *   to call initialize-connection first;
 * - from the third "Connection not initialized" rejection in a row, the error
 *   tells the agent to stop retrying and connect.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createKustoServer } from '../../../src/server.js';
import { KustoConfig } from '../../../src/types/config.js';
import { KustoConnection } from '../../../src/operations/kusto/index.js';

jest.mock('../../../src/common/version.js', () => ({ VERSION: '0.0.0-test' }));

jest.mock('../../../src/operations/kusto/index.js', () => {
  const actual = jest.requireActual('../../../src/operations/kusto/index.js');
  return {
    ...actual,
    KustoConnection: jest.fn(),
    showTables: jest.fn(async () => ({ tables: [] })),
  };
});

const MockConnection = KustoConnection as unknown as jest.Mock;
// Each initialize() call consumes the next outcome; default is success.
let failNext: boolean[] = [];

beforeEach(() => {
  failNext = [];
  MockConnection.mockReset();
  MockConnection.mockImplementation(() => ({
    initialize: async (cluster: string, database: string) => {
      if (failNext.shift()) throw new Error('Connection error: denied');
      return { cluster, database };
    },
  }));
});

async function connect(config: KustoConfig) {
  const server = createKustoServer(config);
  const client = new Client({ name: 'unit-test', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

const text = (r: unknown) =>
  (r as { content: { text: string }[] }).content[0].text;
// The message without the "MCP Error: MCP error -32600: " prefix.
const message = (r: unknown) => text(r).replace(/^.*-32600: /, '');

const NO_CLUSTER =
  'No cluster is configured: call initialize-connection before the first query.';

async function executeQueryDescription(config: KustoConfig) {
  const { client, close } = await connect(config);
  try {
    const { tools } = await client.listTools();
    return tools.find(t => t.name === 'execute-query')?.description ?? '';
  } finally {
    await close();
  }
}

describe('execute-query description when no cluster is configured', () => {
  test('tells the agent to connect first, right after the first sentence', async () => {
    const description = await executeQueryDescription({});
    expect(description).toMatch(
      /^Runs KQL queries and returns results\. No cluster is configured: call initialize-connection before the first query\. If you have not inspected/,
    );
  });

  test('tells the agent to connect first when only the database is missing', async () => {
    const description = await executeQueryDescription({
      clusterUrl: 'https://auto.kusto.windows.net',
    });
    expect(description).toMatch(
      /^Runs KQL queries and returns results\. No database is configured, so nothing connects at startup: call initialize-connection before the first query\. If you have not inspected/,
    );
  });

  test('is unchanged when a cluster is configured', async () => {
    const description = await executeQueryDescription({
      clusterUrl: 'https://auto.kusto.windows.net',
      defaultDatabase: 'db',
    });
    expect(description).not.toContain(NO_CLUSTER);
    expect(description).toMatch(
      /^Runs KQL queries and returns results\. If you have not inspected/,
    );
  });
});

describe('repeated "Connection not initialized" rejections', () => {
  const query = (client: Client) =>
    client.callTool({
      name: 'execute-query',
      arguments: { query: 'T | take 1' },
    });

  test('from the third rejection, tell the agent to stop retrying', async () => {
    const { client, close } = await connect({});
    try {
      for (let i = 0; i < 2; i++) {
        const r = await query(client);
        expect(r.isError).toBe(true);
        expect(text(r)).toMatch(
          /Connection not initialized\. Please call initialize-connection first\.$/,
        );
      }
      const third = await query(client);
      expect(third.isError).toBe(true);
      expect(text(third)).toMatch(
        /Connection not initialized \(3rd attempt without connecting\)\. Stop retrying execute-query: call initialize-connection with a cluster URL first\.$/,
      );
      const fourth = await client.callTool({
        name: 'show-tables',
        arguments: {},
      });
      expect(text(fourth)).toMatch(
        /Connection not initialized \(4th attempt without connecting\)\. Stop retrying show-tables: call initialize-connection with a cluster URL first\.$/,
      );
    } finally {
      await close();
    }
  });

  test('keeps the startup auto-connect failure reason', async () => {
    failNext = [true];
    const { client, close } = await connect({
      clusterUrl: 'https://auto.kusto.windows.net',
      defaultDatabase: 'db',
    });
    try {
      let r;
      for (let i = 0; i < 3; i++) r = await query(client);
      expect(text(r)).toMatch(
        /Connection not initialized \(3rd attempt without connecting\)\. Stop retrying execute-query: call initialize-connection with a cluster URL first\.\nThe startup auto-connect to https:\/\/auto\.kusto\.windows\.net \(database 'db'\) failed: denied/,
      );
    } finally {
      await close();
    }
  });

  test('after a failed initialize-connection, point at the failed connect', async () => {
    failNext = [true];
    const { client, close } = await connect({});
    try {
      for (let i = 0; i < 2; i++) await query(client);
      const init = await client.callTool({
        name: 'initialize-connection',
        arguments: { cluster_url: 'https://x.kusto.windows.net', database: 'd' },
      });
      expect(init.isError).toBe(true);
      const r = await query(client);
      expect(text(r)).toMatch(
        /Connection not initialized \(3rd attempt without connecting\)\. Stop retrying execute-query: initialize-connection failed, so fix the cluster URL or auth and call it again\.$/,
      );
    } finally {
      await close();
    }
  });

  test('keeps the auto-connect-paused wording, with the count and stop sentence', async () => {
    const config = {
      clusterUrl: 'https://auto.kusto.windows.net',
      defaultDatabase: 'db',
    };
    // Three failed launches pause the startup auto-connect (#316).
    failNext = [true, true, true];
    for (let i = 0; i < 3; i++) {
      const { client, close } = await connect(config);
      await query(client);
      await close();
    }
    const { client, close } = await connect(config);
    try {
      for (let i = 0; i < 2; i++) {
        expect(message(await query(client))).toBe(
          'Connection not initialized: auto-connect is paused after repeated failed attempts at startup. Please call initialize-connection to connect.',
        );
      }
      expect(message(await query(client))).toBe(
        'Connection not initialized (3rd attempt without connecting): auto-connect is paused after repeated failed attempts at startup. Stop retrying execute-query: call initialize-connection with a cluster URL first.',
      );
    } finally {
      await close();
    }
  });
});
