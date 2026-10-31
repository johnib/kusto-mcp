/**
 * The connect deadline cancels the token fetch. Before, the token request
 * carried no abort signal, so the cache pinned the fetch and a hung `az` kept
 * running past the deadline (until its own kill timer, set to the same 20s).
 * Now the deadline aborts the request; the cache cancels the inner fetch,
 * which kills the `az` process tree (#346).
 */
const signals: AbortSignal[] = [];
jest.mock('../../../src/auth/az-cli-credential.js', () => ({
  AzCliCredential: class AzCliCredential {
    getToken(_s: unknown, options?: { abortSignal?: AbortSignal }) {
      if (options?.abortSignal) signals.push(options.abortSignal);
      return new Promise(() => {});
    }
  },
}));

import { KustoConnection } from '../../../src/operations/kusto/connection.js';
import { AuthenticationMethod } from '../../../src/types/config.js';

test('a token request still running at the deadline is aborted', async () => {
  const err = await new KustoConnection({
    authMethod: AuthenticationMethod.AzureCli,
    connectionTimeout: 50,
  })
    .initialize('https://acme.kusto.windows.net', 'db')
    .then(
      () => new Error('connected'),
      (e: Error) => e,
    );
  expect(err.message).toMatch(/timed out after 50ms/);
  expect(signals).toHaveLength(1);
  expect(signals[0].aborted).toBe(true);
});
