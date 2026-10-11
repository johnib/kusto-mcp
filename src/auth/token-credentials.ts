import {
  AccessToken,
  AzureCliCredential,
  DefaultAzureCredential,
  GetTokenOptions,
  TokenCredential,
} from '@azure/identity';
import { KustoAuthenticationError } from '../common/errors.js';
import { criticalLog, debugLog } from '../common/utils.js';

/** Refetch a cached token once it is this close to expiry. */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

/**
 * Settle with `promise`, or reject with an AbortError as soon as `signal`
 * aborts. The underlying fetch keeps running: other callers may share it.
 */
function raceAbort<T>(
  promise: Promise<T>,
  signal: GetTokenOptions['abortSignal'],
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort);
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Caches tokens per scope set (and tenant) until TOKEN_REFRESH_MARGIN_MS
 * before they expire, and shares one in-flight request between concurrent
 * callers. Without it every Kusto request calls the inner credential, which
 * for AzureCliCredential spawns `az account get-access-token` (#296).
 * Failures and null results are never cached.
 */
export class CachingTokenCredential implements TokenCredential {
  private readonly cache = new Map<string, AccessToken>();
  private readonly inFlight = new Map<string, Promise<AccessToken | null>>();

  constructor(
    private readonly inner: TokenCredential,
    private readonly now: () => number = Date.now,
  ) {}

  async getToken(
    scopes: string | string[],
    options?: GetTokenOptions,
  ): Promise<AccessToken | null> {
    if (options?.abortSignal?.aborted) throw abortError();

    const scopeList = Array.isArray(scopes) ? scopes : [scopes];
    const key = JSON.stringify([
      [...scopeList].sort(),
      options?.tenantId ?? '',
      !!options?.enableCae,
    ]);

    // A claims challenge means the cached token was rejected: always fetch,
    // and let the new token replace it so later calls don't reuse the old one.
    if (options?.claims) {
      this.cache.delete(key);
      const token = await this.inner.getToken(scopes, options);
      if (token) this.cache.set(key, token);
      return token;
    }

    const cached = this.cache.get(key);
    if (
      cached &&
      cached.expiresOnTimestamp - TOKEN_REFRESH_MARGIN_MS > this.now() &&
      (cached.refreshAfterTimestamp === undefined ||
        cached.refreshAfterTimestamp > this.now())
    ) {
      return cached;
    }

    let pending = this.inFlight.get(key);
    if (!pending) {
      // The shared fetch must not be cancelled by one caller's signal;
      // each caller races its own signal below instead.
      const request = this.inner
        .getToken(scopes, { ...options, abortSignal: undefined })
        .then(token => {
          if (token) this.cache.set(key, token);
          else this.cache.delete(key);
          return token;
        });
      pending = request;
      this.inFlight.set(key, request);
      const clear = () => {
        if (this.inFlight.get(key) === request) this.inFlight.delete(key);
      };
      request.then(clear, clear);
    }
    return raceAbort(pending, options?.abortSignal);
  }
}

/**
 * Factory function to create a TokenCredential based on the authentication method
 *
 * @param method The authentication method to use
 * @returns A TokenCredential instance
 */
export function createTokenCredential(
  method: string = 'azure-cli',
): TokenCredential {
  try {
    switch (method.toLowerCase()) {
      case 'azure-cli':
        debugLog('Using Azure CLI authentication');
        return new CachingTokenCredential(new AzureCliCredential());

      case 'azure-identity':
        debugLog('Using Azure Identity authentication');
        return new CachingTokenCredential(new DefaultAzureCredential());

      default:
        throw new KustoAuthenticationError(
          `Unsupported authentication method: ${method}`,
        );
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    criticalLog(`Failed to create token credential: ${errorMessage}`);
    throw new KustoAuthenticationError(
      `Failed to create token credential: ${errorMessage}`,
    );
  }
}
