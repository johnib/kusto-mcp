/**
 * One credential (and token cache) per process. Each KustoConnection used to
 * build its own, so a manual connect after the startup auto-connect (or any
 * reconnect) ran `az` again from an empty cache. A 401 clears the cache, so a
 * rejected token isn't reused after the user runs `az login`.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

let azRuns = 0;
jest.mock('../../../src/auth/az-cli-credential.js', () => ({
  AzCliCredential: class AzCliCredential {
    async getToken() {
      azRuns++;
      const b64 = (o: unknown) =>
        Buffer.from(JSON.stringify(o)).toString('base64url');
      return {
        token: `${b64({})}.${b64({ tid: 't', oid: 'o' })}.s`,
        expiresOnTimestamp: Date.now() + 3600_000,
      };
    }
  },
}));

let respond: () => Promise<unknown> = async () => ({});
jest.mock('azure-kusto-data', () => ({
  CloudSettings: {
    getCloudInfoForCluster: async () => ({
      KustoServiceResourceId: 'https://kusto.kusto.windows.net',
      LoginMfaRequired: false,
    }),
  },
  KustoConnectionStringBuilder: { withTokenCredential: () => 'cs' },
  Client: class {
    execute() {
      return respond();
    }
    close() {}
  },
  ClientRequestProperties: class {
    setClientTimeout() {}
  },
}));
jest.mock('../../../src/common/version.js', () => ({ VERSION: '0.0.0-test' }));

import { createTokenCredential } from '../../../src/auth/token-credentials.js';
import { KustoConnection } from '../../../src/operations/kusto/connection.js';
import { createKustoServer } from '../../../src/server.js';
import { AuthenticationMethod } from '../../../src/types/config.js';

const CLUSTER = 'https://acme.kusto.windows.net';
const httpError = (status: number) =>
  Object.assign(new Error(`HTTP ${status}`), { response: { status } });

beforeEach(() => {
  azRuns = 0;
  respond = async () => ({});
});

test('auto-connect then a manual connect run az once', async () => {
  const server = createKustoServer({
    authMethod: AuthenticationMethod.AzureCli,
    clusterUrl: CLUSTER,
    defaultDatabase: 'db',
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: 't', version: '1' });
  await client.connect(clientT);
  // The tool call waits for the in-flight auto-connect first.
  const r = await client.callTool({
    name: 'initialize-connection',
    arguments: { cluster_url: CLUSTER, database: 'other' },
  });
  expect(r.isError).toBeFalsy();
  expect(azRuns).toBe(1);
  await client.close();
});

describe('shared cache across connections', () => {
  const config = {
    authMethod: AuthenticationMethod.AzureCli,
    connectionTimeout: 5000,
  };

  test('a 401 clears it: the next connect fetches a new token', async () => {
    const shared = createTokenCredential('azure-cli', 5000);
    // Stop the one tenant retry from also refetching, to see the clear alone.
    (
      shared as unknown as { fallBackToSubscriptionTenant: () => boolean }
    ).fallBackToSubscriptionTenant = () => false;
    respond = async () => {
      throw httpError(401);
    };
    await new KustoConnection(config, shared)
      .initialize(CLUSTER, 'db')
      .catch(() => undefined);
    expect(azRuns).toBe(1);
    respond = async () => ({});
    await new KustoConnection(config, shared).initialize(CLUSTER, 'db');
    expect(azRuns).toBe(2);
  });

  test('a 403 keeps it: the token was valid', async () => {
    const shared = createTokenCredential('azure-cli', 5000);
    respond = async () => {
      throw httpError(403);
    };
    await new KustoConnection(config, shared)
      .initialize(CLUSTER, 'db')
      .catch(() => undefined);
    await new KustoConnection(config, shared)
      .initialize(CLUSTER, 'db')
      .catch(() => undefined);
    expect(azRuns).toBe(1);
  });
});
