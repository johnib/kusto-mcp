/**
 * The connect deadline cancels the token fetch. Before, the token request
 * carried no abort signal, so the cache pinned the fetch and a hung `az` kept
 * running past the deadline (until its own kill timer, set to the same 20s).
 * Now the deadline aborts the request; the cache cancels the inner fetch,
 * which kills the `az` process tree (#346). That includes the one tenant
 * fallback fetch after a 401.
 */
const signals: AbortSignal[] = [];
let tokensBeforeHang = 0;
jest.mock('../../../src/auth/az-cli-credential.js', () => ({
  AzCliCredential: class AzCliCredential {
    private fellBack = false;
    fallBackToSubscriptionTenant() {
      if (this.fellBack) return false;
      this.fellBack = true;
      return true;
    }
    getToken(_s: unknown, options?: { abortSignal?: AbortSignal }) {
      if (options?.abortSignal) signals.push(options.abortSignal);
      if (tokensBeforeHang > 0) {
        tokensBeforeHang--;
        const b64 = (o: unknown) =>
          Buffer.from(JSON.stringify(o)).toString('base64url');
        return Promise.resolve({
          token: `${b64({})}.${b64({ tid: 't', oid: 'o' })}.s`,
          expiresOnTimestamp: Date.now() + 3600_000,
        });
      }
      return new Promise(() => {});
    }
  },
}));

const execute = jest.fn();
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
      return execute();
    }
    close() {}
  },
  ClientRequestProperties: class {
    setClientTimeout() {}
  },
}));

import { KustoConnection } from '../../../src/operations/kusto/connection.js';
import { AuthenticationMethod } from '../../../src/types/config.js';

const connect = (connectionTimeout: number) =>
  new KustoConnection({
    authMethod: AuthenticationMethod.AzureCli,
    connectionTimeout,
  })
    .initialize('https://acme.kusto.windows.net', 'db')
    .then(
      () => new Error('connected'),
      (e: Error) => e,
    );

beforeEach(() => {
  signals.length = 0;
  tokensBeforeHang = 0;
  execute.mockReset();
});

test('a token request still running at the deadline is aborted', async () => {
  const err = await connect(50);
  expect(err.message).toMatch(/timed out after 50ms/);
  expect(signals).toHaveLength(1);
  expect(signals[0].aborted).toBe(true);
});

test('the tenant fallback fetch after a 401 is aborted at the deadline too', async () => {
  tokensBeforeHang = 1;
  execute.mockRejectedValue(
    Object.assign(new Error('401'), { response: { status: 401 } }),
  );
  const err = await connect(200);
  expect(err.message).toMatch(/timed out after 200ms/);
  // First fetch answered; the fallback fetch hung and got the abort.
  expect(signals).toHaveLength(2);
  expect(signals[1].aborted).toBe(true);
  // No validation query after the abandoned fallback.
  expect(execute).toHaveBeenCalledTimes(1);
});
