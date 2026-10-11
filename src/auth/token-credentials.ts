import {
  AccessToken,
  AzureCliCredential,
  DefaultAzureCredential,
  GetTokenOptions,
  TokenCredential,
} from '@azure/identity';
import { AzCliCredential } from './az-cli-credential.js';
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
  private readonly generation = new Map<string, number>();

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
    // and supersede any ordinary fetch already in flight for this key.
    if (options?.claims) {
      this.cache.delete(key);
      return raceAbort(this.fetch(key, scopes, options), options.abortSignal);
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

    const pending = this.inFlight.get(key) ?? this.fetch(key, scopes, options);
    return raceAbort(pending, options?.abortSignal);
  }

  /**
   * Start a fetch for `key` that later callers join. Only the newest fetch
   * for a key may write the cache, so a superseded one (e.g. an ordinary
   * fetch overtaken by a claims refresh) can't restore a rejected token.
   */
  private fetch(
    key: string,
    scopes: string | string[],
    options?: GetTokenOptions,
  ): Promise<AccessToken | null> {
    const generation = (this.generation.get(key) ?? 0) + 1;
    this.generation.set(key, generation);
    // The shared fetch must not be cancelled by one caller's signal;
    // each caller races its own signal instead.
    const request = this.inner
      .getToken(scopes, { ...options, abortSignal: undefined })
      .then(token => {
        if (this.generation.get(key) === generation) {
          if (token) this.cache.set(key, token);
          else this.cache.delete(key);
        }
        return token;
      });
    this.inFlight.set(key, request);
    const clear = () => {
      if (this.inFlight.get(key) === request) this.inFlight.delete(key);
    };
    request.then(clear, clear);
    return request;
  }
}

/**
 * Replace the Azure CLI step of a DefaultAzureCredential with our
 * tree-killing AzCliCredential (#346). Everything else stays the SDK's own:
 * credential order, env vars (incl. AZURE_TOKEN_CREDENTIALS), the managed
 * identity probe, and the chain's fall-through / hard-failure / aggregated
 * error behavior. The SDK's AzureCliCredential gets only processTimeoutInMs
 * from us, so nothing else needs carrying over.
 *
 * DefaultAzureCredential is a ChainedTokenCredential that keeps its steps in
 * `_sources`. If a future SDK drops that field, the credential is returned
 * unchanged (still bounded by processTimeoutInMs); a unit test against the
 * installed SDK fails first.
 */
export function withTreeKillingAzCli<T extends TokenCredential>(
  chain: T,
  timeoutMs?: number,
): T {
  const holder = chain as unknown as { _sources?: unknown };
  if (!Array.isArray(holder._sources)) {
    debugLog('Azure CLI step not swapped: credential chain not recognized');
    return chain;
  }
  holder._sources = holder._sources.map(source =>
    source instanceof AzureCliCredential
      ? new AzCliCredential({ timeoutMs })
      : source,
  );
  return chain;
}

/**
 * Factory function to create a TokenCredential based on the authentication method
 *
 * @param method The authentication method to use
 * @param processTimeoutInMs Kill bound for credential subprocesses (`az`,
 *   `azd`, PowerShell). Without it @azure/identity spawns them with no
 *   timeout, so a hung `az` outlives the connect attempt that started it.
 * @returns A TokenCredential instance
 */
export function createTokenCredential(
  method: string = 'azure-cli',
  processTimeoutInMs?: number,
): TokenCredential {
  // child_process rejects a non-integer timeout, so pass only a sane value.
  const options =
    typeof processTimeoutInMs === 'number' &&
    Number.isInteger(processTimeoutInMs) &&
    processTimeoutInMs > 0
      ? { processTimeoutInMs }
      : {};
  try {
    switch (method.toLowerCase()) {
      case 'azure-cli':
        debugLog('Using Azure CLI authentication');
        // Our own az runner: on timeout it kills the whole process tree, which
        // the SDK's AzureCliCredential doesn't on Windows (#346). Cached (#296).
        return new CachingTokenCredential(
          new AzCliCredential({ timeoutMs: processTimeoutInMs }),
        );

      case 'azure-identity':
        debugLog('Using Azure Identity authentication');
        // The SDK chain, with only its Azure CLI step swapped for ours (#346),
        // wrapped in the token cache (#296).
        return new CachingTokenCredential(
          withTreeKillingAzCli(
            new DefaultAzureCredential(options),
            processTimeoutInMs,
          ),
        );

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
