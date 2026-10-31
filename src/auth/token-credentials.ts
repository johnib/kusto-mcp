import {
  AccessToken,
  AzureCliCredential,
  DefaultAzureCredential,
  GetTokenOptions,
  TokenCredential,
} from '@azure/identity';
import { AzCliCredential } from './az-cli-credential.js';
import { OBSERVE, TokenObservation } from './observe.js';
import { AZ_DEADLINE_AT } from './process-timeout.js';
import { SUBSCRIPTION_TENANT } from './subscription-tenant.js';

function isSubscriptionTenantRequest(options?: GetTokenOptions): boolean {
  return (
    (options as Record<string, unknown> | undefined)?.[SUBSCRIPTION_TENANT] ===
    true
  );
}
import { KustoAuthenticationError } from '../common/errors.js';
import { criticalLog, debugLog } from '../common/utils.js';

/** azure-kusto-data's default authorityId for withAzLoginIdentity. */
export const AZ_LOGIN_DEFAULT_TENANT = 'organizations';

/** Refetch a cached token once it is this close to expiry. */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

/**
 * One inner fetch shared by every concurrent caller for a key. The inner
 * credential gets `controller.signal`, which aborts only once every joined
 * caller has abandoned the fetch, so an abandoned `az` is killed (#346).
 */
interface SharedFetch {
  promise: Promise<AccessToken | null>;
  controller: AbortController;
  /** Joined callers with a signal that haven't aborted yet. */
  waiting: number;
  /** A caller without a signal joined: it can't abandon, so never cancel. */
  pinned: boolean;
  /** Which credential produced the token, once it resolved. */
  source?: CredentialSource;
}

/**
 * Per-caller telemetry for token requests: a caller passes a
 * TokenObservation as the OBSERVE option and the cache counts that caller's
 * own fetches and hits and the token's source. Unlike the shared `stats`,
 * overlapping callers can't mix their numbers.
 */
function observationOf(
  options?: GetTokenOptions,
): TokenObservation | undefined {
  const o = (options as Record<string, unknown> | undefined)?.[OBSERVE];
  return o && typeof o === 'object' ? (o as TokenObservation) : undefined;
}

/**
 * Caches tokens per scope set (and tenant) until TOKEN_REFRESH_MARGIN_MS
 * before they expire, and shares one in-flight request between concurrent
 * callers. Without it every Kusto request calls the inner credential, which
 * for AzureCliCredential spawns `az account get-access-token` (#296).
 * Failures, null results and cancelled fetches are never cached.
 */
export class CachingTokenCredential implements TokenCredential {
  private readonly cache = new Map<string, AccessToken>();
  /** Which credential produced each cached token. */
  private readonly cacheSource = new Map<string, CredentialSource>();
  private readonly inFlight = new Map<string, SharedFetch>();
  private readonly generation = new Map<string, number>();
  /** Telemetry: inner fetches started, and requests served without one. */
  readonly stats = { fetches: 0, hits: 0 };
  /** Telemetry: which credential produced the newest token (bounded enum). */
  lastSource: CredentialSource | undefined;

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
      isSubscriptionTenantRequest(options),
    ]);

    const obs = observationOf(options);

    // A claims challenge means the cached token was rejected: always fetch,
    // and supersede any ordinary fetch already in flight for this key.
    if (options?.claims) {
      this.cache.delete(key);
      if (obs) obs.fetches++;
      return this.join(
        key,
        this.observe(this.fetch(key, scopes, options), obs),
        options,
      );
    }

    const cached = this.cache.get(key);
    if (
      cached &&
      cached.expiresOnTimestamp - TOKEN_REFRESH_MARGIN_MS > this.now() &&
      (cached.refreshAfterTimestamp === undefined ||
        cached.refreshAfterTimestamp > this.now())
    ) {
      this.stats.hits++;
      if (obs) {
        obs.hits++;
        obs.source = this.cacheSource.get(key);
      }
      return cached;
    }

    const joined = this.inFlight.get(key);
    if (joined) this.stats.hits++;
    if (obs) {
      if (joined) obs.hits++;
      else obs.fetches++;
    }
    const shared = joined ?? this.fetch(key, scopes, options);
    const result = this.join(key, this.observe(shared, obs), options);
    if (!joined) return result;
    // A joined fetch runs on its starter's deadline. If az timed out on that
    // one while this caller's own deadline still leaves room, fetch again on
    // this caller's terms rather than fail it on someone else's.
    return result.catch(error => {
      const deadlineAt = (options as Record<string, unknown> | undefined)?.[
        AZ_DEADLINE_AT
      ];
      const roomLeft =
        typeof deadlineAt === 'number' ? deadlineAt - this.now() : Infinity;
      if (
        (error as { azReason?: unknown })?.azReason === 'timeout' &&
        roomLeft > 1000 &&
        !options?.abortSignal?.aborted
      ) {
        return this.getToken(scopes, options);
      }
      throw error;
    });
  }

  /** Copy the fetch's source to the caller's observation when it resolves. */
  private observe(shared: SharedFetch, obs?: TokenObservation): SharedFetch {
    // Registered before join()'s handlers, so it runs before the caller resumes.
    if (obs)
      shared.promise.then(
        () => (obs.source = shared.source),
        () => undefined,
      );
    return shared;
  }

  /**
   * Wait for `shared`, or reject with an AbortError as soon as this caller's
   * signal aborts. When the last caller that could still abandon the fetch
   * does, the inner fetch is cancelled too.
   */
  private join(
    key: string,
    shared: SharedFetch,
    options?: GetTokenOptions,
  ): Promise<AccessToken | null> {
    const signal = options?.abortSignal;
    if (!signal) {
      shared.pinned = true;
      return shared.promise;
    }
    shared.waiting++;
    return new Promise<AccessToken | null>((resolve, reject) => {
      const onAbort = () => {
        reject(abortError());
        shared.waiting--;
        if (!shared.pinned && shared.waiting === 0) this.cancel(key, shared);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      shared.promise.then(
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
   * Forget every cached token. For a 401: the cluster rejected the token, so
   * the next connect (e.g. after `az login`) must fetch a new one. Not for a
   * 403 — that token is valid; Kusto denied access.
   */
  clear(): void {
    this.cache.clear();
    this.cacheSource.clear();
  }

  /** The az step, directly or as a step of the chain. */
  private azStep(): AzCliCredential | undefined {
    const sources = (this.inner as { _sources?: unknown })._sources;
    const candidates = Array.isArray(sources) ? sources : [this.inner];
    return candidates.find(s => s instanceof AzCliCredential) as
      AzCliCredential | undefined;
  }

  /**
   * Whether a request may ask for az's subscription tenant (SUBSCRIPTION_TENANT):
   * there is an az step and its tenant is our default, not AZURE_TENANT_ID.
   * Such requests are cached under their own key and go straight to az, so
   * they never change what other callers get.
   */
  canUseSubscriptionTenant(): boolean {
    return !!this.azStep()?.allowsSubscriptionTenant;
  }

  /**
   * One call to the inner credential, recording which credential produced
   * the token. A chained credential (DefaultAzureCredential) exposes
   * getTokenInternal, which also returns the step that succeeded; it is the
   * same walk getToken does, minus the SDK's tracing span. Without it, the
   * inner credential itself is the source.
   */
  private async fetchInner(
    scopes: string | string[],
    options: GetTokenOptions,
  ): Promise<{ token: AccessToken | null; source?: CredentialSource }> {
    // A subscription-tenant request goes straight to the az step: no other
    // chain step should answer it.
    if (isSubscriptionTenantRequest(options)) {
      const az = this.azStep();
      if (!az?.allowsSubscriptionTenant) return { token: null };
      return { token: await az.getToken(scopes, options), source: 'az' };
    }
    const chain = this.inner as {
      getTokenInternal?: (
        scopes: string | string[],
        options?: GetTokenOptions,
      ) => Promise<{ token: AccessToken; successfulCredential: unknown }>;
    };
    if (typeof chain.getTokenInternal === 'function') {
      const { token, successfulCredential } = await chain.getTokenInternal(
        scopes,
        options,
      );
      return { token, source: credentialSourceOf(successfulCredential) };
    }
    const token = await this.inner.getToken(scopes, options);
    return {
      token,
      source: token ? credentialSourceOf(this.inner) : undefined,
    };
  }

  /** Abort an abandoned fetch; later callers start a fresh one. */
  private cancel(key: string, shared: SharedFetch): void {
    if (this.inFlight.get(key) === shared) this.inFlight.delete(key);
    shared.controller.abort();
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
  ): SharedFetch {
    const generation = (this.generation.get(key) ?? 0) + 1;
    this.generation.set(key, generation);
    this.stats.fetches++;
    // No caller's own signal reaches the shared fetch: it is aborted only
    // through cancel(), once every joined caller has given up.
    const controller = new AbortController();
    const promise = this.fetchInner(scopes, {
      ...options,
      abortSignal: controller.signal,
    }).then(({ token, source }) => {
      shared.source = source;
      if (source) this.lastSource = source;
      if (
        !controller.signal.aborted &&
        this.generation.get(key) === generation
      ) {
        if (token) {
          this.cache.set(key, token);
          if (source) this.cacheSource.set(key, source);
        } else this.cache.delete(key);
      }
      return token;
    });
    const shared: SharedFetch = {
      promise,
      controller,
      waiting: 0,
      pinned: false,
    };
    this.inFlight.set(key, shared);
    const clear = () => {
      if (this.inFlight.get(key) === shared) this.inFlight.delete(key);
    };
    promise.then(clear, clear);
    return shared;
  }
}

/** Bounded name of the credential that produced a token (telemetry). */
export type CredentialSource =
  'env' | 'wi' | 'mi' | 'vscode' | 'az' | 'pwsh' | 'azd' | 'broker' | 'unknown';

/** Map a credential's class name to a CredentialSource. Never the instance. */
export function credentialSourceOf(credential: unknown): CredentialSource {
  const name =
    (credential as { constructor?: { name?: string } })?.constructor?.name ??
    '';
  switch (name) {
    case 'EnvironmentCredential':
      return 'env';
    case 'WorkloadIdentityCredential':
      return 'wi';
    case 'ManagedIdentityCredential':
      return 'mi';
    case 'VisualStudioCodeCredential':
      return 'vscode';
    case 'AzureCliCredential':
    case 'AzCliCredential':
      return 'az';
    case 'AzurePowerShellCredential':
      return 'pwsh';
    case 'AzureDeveloperCliCredential':
      return 'azd';
    case 'BrokerCredential':
      return 'broker';
    default:
      return 'unknown';
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
      ? new AzCliCredential({ timeoutMs, ...azTenantOptions() })
      : source,
  );
  return chain;
}

/**
 * DefaultAzureCredential throws in its constructor when AZURE_TOKEN_CREDENTIALS
 * names no known credential — before any connect span, so the user gets an
 * opaque failure and we get no telemetry. Return a credential that fails
 * every request with the reason instead, so the connect reports it. Never
 * the full chain: the variable limits who may sign in, and a typo must not
 * widen that.
 */
function defaultAzureCredential(
  options: ConstructorParameters<typeof DefaultAzureCredential>[0],
): TokenCredential {
  try {
    return new DefaultAzureCredential(options);
  } catch (error) {
    const selector = process.env.AZURE_TOKEN_CREDENTIALS;
    if (selector === undefined) throw error;
    const message = `AZURE_TOKEN_CREDENTIALS="${selector}" is not valid (${
      error instanceof Error ? error.message : String(error)
    }). Fix or unset it, then connect again.`;
    criticalLog(message);
    // A plain Error: the connect adds the "Authentication error" prefix.
    return { getToken: () => Promise.reject(new Error(message)) };
  }
}

/**
 * The `--tenant` for every `az` step: AZURE_TENANT_ID when set (the user's
 * choice, kept), else `organizations` — the account's home tenant, which a
 * 401 may later swap for az's subscription tenant. Without a tenant, az
 * answers from its current subscription's tenant, which 401s when that is
 * not the cluster's (#350). The SDK's own az step ignores AZURE_TENANT_ID.
 */
function azTenantOptions(): {
  tenantId: string;
  subscriptionTenantFallback: boolean;
} {
  const pinned = process.env.AZURE_TENANT_ID?.trim();
  return pinned
    ? { tenantId: pinned, subscriptionTenantFallback: false }
    : { tenantId: AZ_LOGIN_DEFAULT_TENANT, subscriptionTenantFallback: true };
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
        // `--tenant organizations`, as 1.18.0 sent through azure-kusto-data's
        // withAzLoginIdentity (its default authorityId): the token comes from
        // the account's home tenant, not the current subscription's tenant.
        // AZURE_TENANT_ID overrides it (see azTenantOptions).
        return new CachingTokenCredential(
          new AzCliCredential({
            timeoutMs: processTimeoutInMs,
            ...azTenantOptions(),
          }),
        );

      case 'azure-identity':
        debugLog('Using Azure Identity authentication');
        // The SDK chain, with only its Azure CLI step swapped for ours (#346),
        // wrapped in the token cache (#296).
        return new CachingTokenCredential(
          withTreeKillingAzCli(
            defaultAzureCredential(options),
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
