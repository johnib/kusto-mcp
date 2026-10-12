/**
 * #293: a connect attempt that hit its deadline keeps running. Its late token
 * result must not change identity state, it must not go on to the validation
 * query, and the credential's `az` subprocess must be bounded by a timeout.
 */

const azureCliCtor = jest.fn();
const defaultCtor = jest.fn();
let pendingToken: {
  resolve: (v: { token: string }) => void;
  reject: (e: unknown) => void;
} | null = null;

jest.mock('@azure/identity', () => {
  const getToken = () =>
    new Promise((resolve, reject) => {
      pendingToken = { resolve, reject };
    });
  return {
    AzureCliCredential: class {
      constructor(opts: unknown) {
        azureCliCtor(opts);
      }
      getToken = getToken;
    },
    DefaultAzureCredential: class {
      constructor(opts: unknown) {
        defaultCtor(opts);
      }
      getToken = getToken;
    },
  };
});

// azure-cli runs our own az credential (#346); give it the same pending token.
jest.mock('../../../src/auth/az-cli-credential.js', () => ({
  AzCliCredential: class {
    constructor(opts: unknown) {
      azureCliCtor(opts);
    }
    getToken = () =>
      new Promise((resolve, reject) => {
        pendingToken = { resolve, reject };
      });
  },
}));

jest.mock('azure-kusto-data', () => ({
  Client: jest.fn(),
  KustoConnectionStringBuilder: {
    withAzLoginIdentity: jest.fn(u => `cs-${u}`),
    withTokenCredential: jest.fn(u => `cs-${u}`),
  },
  ClientRequestProperties: class {
    setClientTimeout() {
      /* no-op for tests */
    }
  },
}));

import { createTokenCredential } from '../../../src/auth/token-credentials.js';
import {
  captureIdentity,
  clearIdentity,
  getIdentityAttributes,
} from '../../../src/common/identity.js';
import { KustoConnection } from '../../../src/operations/kusto/connection.js';
import { AuthenticationMethod } from '../../../src/types/config.js';

const CLUSTER = 'https://help.kusto.windows.net';

function makeJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
}

const flush = () => new Promise(r => setImmediate(r));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('abandoned connect attempts (#293)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pendingToken = null;
    clearIdentity();
  });

  describe('credential subprocess timeout', () => {
    test('the azure-cli credential gets the timeout', () => {
      createTokenCredential('azure-cli', 1500);
      expect(azureCliCtor).toHaveBeenCalledWith({
        timeoutMs: 1500,
        tenantId: 'organizations',
      });
    });

    test('DefaultAzureCredential gets processTimeoutInMs', () => {
      createTokenCredential('azure-identity', 1500);
      expect(defaultCtor).toHaveBeenCalledWith({ processTimeoutInMs: 1500 });
    });

    test('an invalid timeout is not passed through (execFile would reject it)', () => {
      createTokenCredential('azure-identity', NaN);
      expect(defaultCtor).toHaveBeenCalledWith({});
    });

    test('KustoConnection bounds the credential by its connection timeout', () => {
      new KustoConnection({
        authMethod: AuthenticationMethod.AzureCli,
        connectionTimeout: 1500,
      });
      expect(azureCliCtor).toHaveBeenCalledWith({
        timeoutMs: 1500,
        tenantId: 'organizations',
      });
    });

    test('azure-cli validation uses our bounded credential, not the SDK az login', async () => {
      const {
        Client,
        KustoConnectionStringBuilder,
      } = require('azure-kusto-data');
      Client.mockImplementation(() => ({
        execute: jest.fn().mockResolvedValue({}),
      }));
      const conn = new KustoConnection({
        authMethod: AuthenticationMethod.AzureCli,
        connectionTimeout: 1000,
      });
      const init = conn.initialize(CLUSTER, 'Samples');
      await flush();
      pendingToken!.resolve({ token: makeJwt({ tid: 't', oid: 'o' }) });
      await init;
      expect(
        KustoConnectionStringBuilder.withTokenCredential,
      ).toHaveBeenCalled();
      expect(
        KustoConnectionStringBuilder.withAzLoginIdentity,
      ).not.toHaveBeenCalled();
    });
  });

  describe('late token results after the deadline', () => {
    async function timeOutDuringToken() {
      const { Client } = require('azure-kusto-data');
      const conn = new KustoConnection({
        authMethod: AuthenticationMethod.AzureCli,
        connectionTimeout: 30,
      });
      await expect(conn.initialize(CLUSTER, 'Samples')).rejects.toThrow(
        /timed out/i,
      );
      expect(pendingToken).not.toBeNull();
      return Client;
    }

    test('a token that resolves after the deadline does not capture identity', async () => {
      const Client = await timeOutDuringToken();
      const before = getIdentityAttributes();

      pendingToken!.resolve({
        token: makeJwt({ tid: 'late-tenant', oid: 'late-user' }),
      });
      await flush();

      expect(getIdentityAttributes()).toEqual(before);
      expect(getIdentityAttributes()['kustomcp.user_hash']).toBeUndefined();
      // The abandoned attempt stops instead of running the validation query.
      expect(Client).not.toHaveBeenCalled();
    });

    test('a token that rejects after the deadline does not change identity state', async () => {
      await timeOutDuringToken();
      const before = getIdentityAttributes();

      pendingToken!.reject(
        Object.assign(new Error('late'), {
          name: 'CredentialUnavailableError',
        }),
      );
      await flush();

      expect(getIdentityAttributes()).toEqual(before);
    });

    test('a late failure from an older capture cannot overwrite a newer success', async () => {
      const older = deferred<{ token: string }>();
      const olderCapture = captureIdentity(CLUSTER, () => older.promise);

      await captureIdentity(CLUSTER, async () => ({
        token: makeJwt({ tid: 'new-tenant', oid: 'new-user' }),
      }));
      const captured = getIdentityAttributes();
      expect(captured['kustomcp.identity_state']).toBe('captured');

      older.reject(new Error('late'));
      await olderCapture;

      // Attributes and state still agree: no failure attrs under 'captured'.
      expect(getIdentityAttributes()).toEqual(captured);
      expect(
        getIdentityAttributes()['kustomcp.auth.token_acquired'],
      ).toBeUndefined();
    });

    test('a late success from an older capture cannot overwrite a newer one', async () => {
      const older = deferred<{ token: string }>();
      const olderCapture = captureIdentity(CLUSTER, () => older.promise);

      await captureIdentity(CLUSTER, async () => ({
        token: makeJwt({ tid: 'new-tenant', oid: 'new-user' }),
      }));
      const captured = getIdentityAttributes();

      older.resolve({ token: makeJwt({ tid: 'old-tenant', oid: 'old-user' }) });
      await olderCapture;

      expect(getIdentityAttributes()).toEqual(captured);
    });

    test('an isAbandoned check that throws never makes captureIdentity throw', async () => {
      await expect(
        captureIdentity(
          CLUSTER,
          async () => ({ token: makeJwt({ tid: 't', oid: 'o' }) }),
          () => {
            throw new Error('boom');
          },
        ),
      ).resolves.toBeDefined();
      expect(getIdentityAttributes()['kustomcp.user_hash']).toBeUndefined();
    });
  });
});
