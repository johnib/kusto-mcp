/**
 * #315: a failed connect names the failed step and the likely fix, built only
 * from the bounded failure categories. After a failed startup auto-connect,
 * later "not initialized" errors carry the remembered reason.
 */

import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

jest.mock('../../../src/common/version.js', () => ({ VERSION: '0.0.0-test' }));

jest.mock('azure-kusto-data', () => ({
  // Cloud metadata lookup (connect step 1): public cloud, no MFA.
  CloudSettings: {
    getCloudInfoForCluster: async () => ({
      KustoServiceResourceId: 'https://kusto.kusto.windows.net',
      LoginMfaRequired: false,
    }),
  },
  Client: jest.fn(),
  KustoConnectionStringBuilder: {
    withAzLoginIdentity: jest.fn(u => `cs-${u}`),
    withTokenCredential: jest.fn(u => `cs-${u}`),
  },
  ClientRequestProperties: class {
    setClientTimeout() {
      /* no-op for tests */
    }
    setTimeout() {
      /* no-op for tests */
    }
  },
}));

const getToken = jest.fn();
jest.mock('../../../src/auth/token-credentials.js', () => ({
  createTokenCredential: jest.fn(() => ({ getToken })),
}));

import {
  connectionFailureHint,
  ConnectionHintInput,
  probeReachability,
} from '../../../src/common/connection-hints.js';
import { KustoConnectionError } from '../../../src/common/errors.js';
import { KustoConnection } from '../../../src/operations/kusto/connection.js';
import { createKustoServer } from '../../../src/server.js';
import {
  AuthenticationMethod,
  KustoConfig,
} from '../../../src/types/config.js';

const CLUSTER = 'https://acme.kusto.windows.net';
const DB = 'Sales';

const base: ConnectionHintInput = {
  category: 'unknown',
  tokenFailed: false,
  authMethod: 'azure-cli',
  source: 'manual',
  clusterUrl: CLUSTER,
  database: DB,
  timeoutMs: 20000,
};
const hint = (over: Partial<ConnectionHintInput>) =>
  connectionFailureHint({ ...base, ...over });

function credentialUnavailable(): Error {
  const e = new Error('Azure CLI could not be found');
  e.name = 'CredentialUnavailableError';
  return e;
}

function aadError(error: string, code: number): Error {
  const e = new Error('AADSTS sign-in failure') as Error & {
    errorResponse: unknown;
  };
  e.name = 'AuthenticationError';
  e.errorResponse = { error, errorCodes: [code] };
  return e;
}

function httpError(status: number): Error {
  const e = new Error(`Request failed with status code ${status}`) as Error & {
    response: unknown;
  };
  e.name = 'AxiosError';
  e.response = {
    status,
    data: { error: { '@message': `server says ${status}` } },
  };
  return e;
}

describe('connectionFailureHint mapping (#315)', () => {
  test.each<[string, Partial<ConnectionHintInput>, RegExp]>([
    [
      'credential_unavailable + azure-cli → az login',
      { tokenFailed: true, authStage: 'credential_unavailable' },
      /^Failed step: getting an Azure token\. Azure CLI is not signed in.*run `az login`/,
    ],
    [
      'credential_unavailable + default credential → az login or SP vars',
      {
        tokenFailed: true,
        authStage: 'credential_unavailable',
        authMethod: 'azure-identity',
      },
      /No Azure credential was found – run `az login` \(or set AZURE_TENANT_ID/,
    ],
    [
      'interactive_required → az login again',
      { tokenFailed: true, authStage: 'interactive_required' },
      /MFA or a fresh login – run `az login` again/,
    ],
    [
      'conditional_access → az login again',
      { tokenFailed: true, authStage: 'conditional_access' },
      /MFA or a fresh login – run `az login` again/,
    ],
    [
      'invalid_grant → az login again',
      { tokenFailed: true, authStage: 'invalid_grant' },
      /expired or was revoked – run `az login` again/,
    ],
    [
      'tenant mismatch AADSTS → az login --tenant',
      {
        tokenFailed: true,
        authStage: 'token_acquire',
        aadsts: 'AADSTS50020',
      },
      /not in the cluster's tenant \(AADSTS50020\) – run `az login --tenant <tenant-id>`/,
    ],
    [
      'resource not in tenant AADSTS500011 → check URL or tenant',
      {
        tokenFailed: true,
        authStage: 'token_acquire',
        aadsts: 'AADSTS500011',
      },
      /does not know acme\.kusto\.windows\.net.*az login --tenant/,
    ],
    [
      'generic token failure → az login / --tenant',
      { tokenFailed: true, authStage: 'token_acquire' },
      /Couldn't get an Azure token for acme\.kusto\.windows\.net – run `az login` \(or `az login --tenant <tenant-id>`/,
    ],
    [
      'KustoAuthenticationError (auth) → token step',
      { category: 'auth' },
      /^Failed step: getting an Azure token\./,
    ],
    [
      'authz 403 → no access to <db> on <cluster>, ask for Viewer',
      { category: 'authz', httpStatus: 403 },
      /^Failed step: opening the database\. You are signed in but have no access to database 'Sales' on acme\.kusto\.windows\.net \(HTTP 403\) – ask its admin for the Viewer role\./,
    ],
    [
      'authz 401 → tenant hint',
      { category: 'authz', httpStatus: 401 },
      /rejected your token \(HTTP 401\).*az login --tenant/,
    ],
    [
      'http_4xx → check database name',
      { category: 'http_4xx', httpStatus: 400 },
      /opening the database\. .*\(HTTP 400\) – check that database 'Sales' \(the database argument\) exists/,
    ],
    [
      'http_5xx → cluster unhealthy',
      { category: 'http_5xx', httpStatus: 503 },
      /reaching the cluster\. .*server error \(HTTP 503\)/,
    ],
    [
      'throttled → wait and retry',
      { category: 'throttled', httpStatus: 429 },
      /throttling requests \(HTTP 429\) – wait a minute/,
    ],
    [
      'dns_resolution (manual) → check cluster_url',
      { category: 'dns_resolution' },
      /^Failed step: reaching the cluster\. Can't resolve the cluster host acme\.kusto\.windows\.net – check the cluster_url argument\.$/,
    ],
    [
      'dns_resolution (auto) → check KUSTO_CLUSTER_URL',
      { category: 'dns_resolution', source: 'auto' },
      /check KUSTO_CLUSTER_URL\.$/,
    ],
    [
      'connection_refused → check host and port',
      { category: 'connection_refused' },
      /refused the connection – check the host and port/,
    ],
    [
      'tls → certificate / proxy',
      { category: 'tls' },
      /TLS\/certificate error.*proxy.*NODE_EXTRA_CA_CERTS/,
    ],
    [
      'network → network/VPN/proxy',
      { category: 'network' },
      /Network error talking to .* VPN or proxy/,
    ],
    [
      'timeout while reaching the cluster → no response within Ns',
      { category: 'timeout', timedOutStep: 'cluster', timeoutMs: 8000 },
      /^Failed step: reaching the cluster\. No response from acme\.kusto\.windows\.net within 8s – check your network\/VPN/,
    ],
    [
      'timeout while getting a token → az login',
      { category: 'timeout', timedOutStep: 'token' },
      /^Failed step: getting an Azure token\. No token within 20s – run `az login` again/,
    ],
    [
      'network cause wins over a token failure (bad URL breaks both)',
      {
        category: 'dns_resolution',
        tokenFailed: true,
        authStage: 'token_acquire',
      },
      /^Failed step: reaching the cluster\. Can't resolve/,
    ],
    [
      'unknown → generic check URL / network / az login',
      { category: 'unknown' },
      /^Failed step: reaching the cluster\. Couldn't connect to acme\.kusto\.windows\.net – check the cluster_url argument/,
    ],
  ])('%s', (_name, over, expected) => {
    expect(hint(over)).toMatch(expected);
  });
});

describe('KustoConnection.initialize failure text (#315)', () => {
  const { Client } = jest.requireMock('azure-kusto-data');
  const probe = probeReachability as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    getToken.mockResolvedValue({ token: 'x.e30.y' });
    probe.mockResolvedValue(undefined);
  });

  const config: KustoConfig = {
    authMethod: AuthenticationMethod.AzureCli,
    connectionTimeout: 1000,
  };

  test('a 400 for the database keeps the server message and names the database step', async () => {
    Client.mockImplementation(() => ({
      execute: jest.fn().mockRejectedValue(httpError(400)),
    }));
    const err = await new KustoConnection(config)
      .initialize(CLUSTER, DB)
      .catch(e => e);
    expect(err).toBeInstanceOf(KustoConnectionError);
    expect(err.name).toBe('KustoConnectionError');
    expect(err.message).toBe(
      "Connection error: server says 400\nFailed step: opening the database. acme.kusto.windows.net rejected the request (HTTP 400) – check that database 'Sales' (the database argument) exists; names are case-sensitive.",
    );
  });

  test('a token failure with azure-cli tells the user to run az login', async () => {
    getToken.mockRejectedValue(credentialUnavailable());
    const execute = jest.fn().mockRejectedValue(new Error('sdk auth failed'));
    Client.mockImplementation(() => ({ execute }));
    const err = await new KustoConnection(config)
      .initialize(CLUSTER, DB)
      .catch(e => e);
    expect(err).toBeInstanceOf(KustoConnectionError);
    // The credential's own error, not the SDK's second walk of the chain.
    expect(err.message).toMatch(
      /^Connection error: Authentication error: Azure CLI could not be found\nFailed step: getting an Azure token\. Azure CLI is not signed in .*run `az login`/,
    );
    // Fails fast: no validation query after a failed token.
    expect(execute).not.toHaveBeenCalled();
  });

  test('an MFA-required token failure tells the user to az login again', async () => {
    getToken.mockRejectedValue(aadError('interaction_required', 50076));
    Client.mockImplementation(() => ({
      execute: jest.fn().mockRejectedValue(new Error('sdk auth failed')),
    }));
    const err = await new KustoConnection(config)
      .initialize(CLUSTER, DB)
      .catch(e => e);
    expect(err.message).toMatch(/MFA or a fresh login – run `az login` again/);
  });

  test('an unclassified failure is refined by the reachability probe', async () => {
    probe.mockResolvedValue('dns_resolution');
    Client.mockImplementation(() => ({
      execute: jest
        .fn()
        .mockRejectedValue(new Error('Failed to get cloud info for cluster')),
    }));
    const err = await new KustoConnection(config)
      .initialize(CLUSTER, DB, 'auto')
      .catch(e => e);
    expect(probe).toHaveBeenCalledWith(
      CLUSTER,
      expect.any(Number),
      expect.any(Function),
    );
    expect(probe.mock.calls[0][1]).toBeLessThanOrEqual(1000);
    expect(err.message).toMatch(
      /\nFailed step: reaching the cluster\. Can't resolve the cluster host acme\.kusto\.windows\.net – check KUSTO_CLUSTER_URL\.$/,
    );
  });

  test('a slow probe cannot push initialize past connectionTimeout', async () => {
    // The probe waits its whole budget; the SDK fails late in the window.
    probe.mockImplementation(
      (_url: string, ms: number) => new Promise(r => setTimeout(r, ms)),
    );
    Client.mockImplementation(() => ({
      execute: jest.fn(
        () =>
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('cloud info failed')), 700),
          ),
      ),
    }));
    const started = Date.now();
    const err = await new KustoConnection(config)
      .initialize(CLUSTER, DB)
      .catch(e => e);
    expect(err).toBeInstanceOf(KustoConnectionError);
    expect(Date.now() - started).toBeLessThan(1150);
    expect(probe.mock.calls[0][1]).toBeLessThanOrEqual(1000 - 700);
  });

  test('the deadline message is not double-prefixed and says how long it waited', async () => {
    Client.mockImplementation(() => ({
      execute: jest.fn(() => new Promise(() => {})),
    }));
    const err = await new KustoConnection({
      ...config,
      connectionTimeout: 50,
    })
      .initialize(CLUSTER, DB)
      .catch(e => e);
    expect(err).toBeInstanceOf(KustoConnectionError);
    expect(err.message).toMatch(
      /^Connection error: Connection timed out after 50ms\nFailed step: reaching the cluster\. No response from acme\.kusto\.windows\.net within 50ms/,
    );
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('server: connection failures reach the agent with the hint (#315)', () => {
  const { Client } = jest.requireMock('azure-kusto-data');

  beforeEach(() => {
    jest.clearAllMocks();
    getToken.mockResolvedValue({ token: 'x.e30.y' });
    (probeReachability as jest.Mock).mockResolvedValue(undefined);
    Client.mockImplementation(() => ({
      execute: jest.fn().mockRejectedValue(httpError(403)),
    }));
  });

  async function connect(config: KustoConfig) {
    const server = createKustoServer(config);
    const client = new McpClient({ name: 'unit-test', version: '0.0.0' });
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

  test('initialize-connection failure names the step and the fix', async () => {
    const { client, close } = await connect({ connectionTimeout: 1000 });
    try {
      const r = await client.callTool({
        name: 'initialize-connection',
        arguments: { cluster_url: CLUSTER, database: DB },
      });
      expect(r.isError).toBe(true);
      expect(text(r)).toBe(
        "Kusto Connection Error: Connection error: server says 403\nFailed step: opening the database. You are signed in but have no access to database 'Sales' on acme.kusto.windows.net (HTTP 403) – ask its admin for the Viewer role.",
      );
    } finally {
      await close();
    }
  });

  test('after a failed startup auto-connect, tool calls include the reason', async () => {
    const { client, close } = await connect({
      clusterUrl: CLUSTER,
      defaultDatabase: DB,
      connectionTimeout: 1000,
    });
    try {
      const r = await client.callTool({ name: 'show-tables', arguments: {} });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(
        /Connection not initialized\. Please call initialize-connection first\.\nThe startup auto-connect to https:\/\/acme\.kusto\.windows\.net \(database 'Sales'\) failed: server says 403\nFailed step: opening the database\. You are signed in but have no access to database 'Sales'/,
      );
    } finally {
      await close();
    }
  });

  test('a slow probe does not hide the reason from the first tool call', async () => {
    // Fake clock: the probe uses its whole budget and the SDK fails late in
    // the window, so the auto-connect settles exactly at connectionTimeout.
    // Real timers made this a race against the tool call's own wait.
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'],
    });
    try {
      (probeReachability as jest.Mock).mockImplementation(
        (_url: string, ms: number) => new Promise(r => setTimeout(r, ms)),
      );
      Client.mockImplementation(() => ({
        execute: jest.fn(
          () =>
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('cloud info failed')), 700),
            ),
        ),
      }));
      const { client, close } = await connect({
        clusterUrl: CLUSTER,
        defaultDatabase: DB,
        connectionTimeout: 1000,
      });
      try {
        const pending = client.callTool({ name: 'show-tables', arguments: {} });
        await jest.advanceTimersByTimeAsync(5000);
        const r = await pending;
        expect(r.isError).toBe(true);
        expect(text(r)).toMatch(
          /The startup auto-connect to https:\/\/acme\.kusto\.windows\.net \(database 'Sales'\) failed: cloud info failed\nFailed step: reaching the cluster\./,
        );
      } finally {
        await close();
      }
    } finally {
      jest.useRealTimers();
    }
  });

  test('a manual connect attempt clears the remembered auto-connect reason', async () => {
    const { client, close } = await connect({
      clusterUrl: CLUSTER,
      defaultDatabase: DB,
      connectionTimeout: 1000,
    });
    try {
      await client.callTool({ name: 'show-tables', arguments: {} });
      await client.callTool({
        name: 'initialize-connection',
        arguments: { cluster_url: CLUSTER, database: DB },
      });
      const r = await client.callTool({ name: 'show-tables', arguments: {} });
      expect(r.isError).toBe(true);
      expect(text(r)).not.toMatch(/startup auto-connect/);
    } finally {
      await close();
    }
  });
});
