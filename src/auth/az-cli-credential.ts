import type { ChildProcess } from 'node:child_process';
import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import { spawn as safeSpawn } from '@azure/core-process';
import type {
  AccessToken,
  GetTokenOptions,
  TokenCredential,
} from '@azure/identity';
import { debugLog } from '../common/utils.js';
import { AZ_DEADLINE_AT, azTimeoutUntil } from './process-timeout.js';
import { SUBSCRIPTION_TENANT } from './subscription-tenant.js';

/**
 * Azure CLI token credential that kills the whole `az` process tree when it
 * times out or is aborted (#346).
 *
 * @azure/identity's AzureCliCredential runs `az` through child_process'
 * timeout, which kills only the direct child. On Windows that child is
 * `cmd.exe` running `az.cmd`, so the real `az` (`python.exe`) survives and
 * hung ones pile up. The SDK doesn't expose the pid, so we spawn `az`
 * ourselves. Launching goes through @azure/core-process (the same safe
 * launcher the SDK uses: PATH resolution, trusted cmd.exe, batch-argument
 * escaping); only the kill differs.
 */

// Same messages as @azure/identity, so hints and users see familiar text.
export const AZ_CLI_MESSAGES = {
  notInstalled:
    "Azure CLI could not be found. Please visit https://aka.ms/azure-cli for installation instructions and then, once installed, authenticate to your Azure account using 'az login'.",
  login:
    "Please run 'az login' from a command prompt to authenticate before using this credential.",
  claims:
    "This credential doesn't support claims challenges. Please run 'az login' with the required claims.",
  unknown: 'Unknown error while trying to retrieve the access token',
  unexpectedResponse: 'Unexpected response from Azure CLI when getting token.',
  timeout: 'Azure CLI timed out while getting a token.',
} as const;

/**
 * Same class name as @azure/identity's, which is what classifyAuthError keys
 * on (`credential_unavailable`). Defined here because the unit suite mocks
 * @azure/identity wholesale.
 */
export class CredentialUnavailableError extends Error {
  constructor(
    message: string,
    /** Why `az` failed (bounded); read by classifyAuthError and the hint. */
    readonly azReason: AzReason = 'other',
    /** The AADSTS code in az's output, digits only. */
    readonly aadstsCode?: string,
  ) {
    super(message);
    this.name = 'CredentialUnavailableError';
  }
}

/** Why `az account get-access-token` gave no token. Bounded enum. */
export type AzReason =
  | 'not_found'
  | 'not_logged_in'
  | 'expired'
  | 'mfa_required'
  | 'tenant'
  | 'timeout'
  | 'bad_response'
  | 'other';

// AADSTS codes, by what the user has to do about them.
const EXPIRED_CODES = new Set([
  '700082', // refresh token expired (inactivity)
  '700084', // refresh token expired (SPA lifetime)
  '50173', // grant expired: password changed / session revoked
  '70043', // refresh token expired (sign-in frequency policy)
  '50133', // session invalid: password expired or changed
]);
const MFA_CODES = new Set([
  '50076', // MFA required
  '50079', // MFA registration required
  '50158', // external security challenge
  '53003', // blocked by conditional access
  '50005', // conditional access: unsupported platform
]);
const TENANT_CODES = new Set([
  '50020', // user not in the tenant
  '90072', // user not in the tenant (external IdP)
  '500011', // resource not found in the tenant
  '90002', // tenant not found
]);

/**
 * Classify az's stderr into a bounded reason and the AADSTS code (digits).
 * Reads the raw text locally; only the enum and the digits leave this
 * function. Runs BEFORE azCliFailure replaces the message, which would hide
 * an AADSTS code behind the generic "run az login" text.
 */
export function azFailureReason(stderr: string): {
  reason: AzReason;
  aadsts?: string;
} {
  const text = stderr.trim();
  if (
    /az:(.*)not found/.test(text) ||
    text.startsWith("'az' is not recognized")
  )
    return { reason: 'not_found' };
  const aadsts = /AADSTS(\d{5,7})/.exec(text)?.[1];
  if (aadsts) {
    if (EXPIRED_CODES.has(aadsts)) return { reason: 'expired', aadsts };
    if (MFA_CODES.has(aadsts)) return { reason: 'mfa_required', aadsts };
    if (TENANT_CODES.has(aadsts)) return { reason: 'tenant', aadsts };
    return { reason: 'other', aadsts };
  }
  if (/az login/.test(text)) return { reason: 'not_logged_in' };
  return { reason: 'other' };
}

class AbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AbortError';
  }
}

// Same allow-list as @azure/identity's ensureValidScopeForDevTimeCreds.
const SAFE_SCOPE = /^[0-9a-zA-Z-_.:/]+$/;
// Same allow-list as @azure/identity's checkTenantId.
const SAFE_TENANT = /^[0-9a-zA-Z-.]+$/;

/** Parse `az account get-access-token --output json`. Never logs the token. */
export function parseAzCliTokenResponse(stdout: string): AccessToken {
  let response: {
    accessToken?: unknown;
    expires_on?: unknown;
    expiresOn?: unknown;
  };
  const badResponse = () =>
    new CredentialUnavailableError(
      AZ_CLI_MESSAGES.unexpectedResponse,
      'bad_response',
    );
  try {
    response = JSON.parse(stdout);
  } catch {
    throw badResponse();
  }
  const token = response?.accessToken;
  if (typeof token !== 'string' || !token) {
    throw badResponse();
  }
  // expires_on (epoch seconds, az >= 2.54) is preferred; expiresOn is a local
  // date string on older versions.
  let expiresOnTimestamp = Number.parseInt(String(response.expires_on), 10);
  expiresOnTimestamp = Number.isNaN(expiresOnTimestamp)
    ? new Date(String(response.expiresOn)).getTime()
    : expiresOnTimestamp * 1000;
  if (Number.isNaN(expiresOnTimestamp)) {
    throw badResponse();
  }
  return { token, expiresOnTimestamp, tokenType: 'Bearer' };
}

/** Map a failed `az` run (nonzero exit) to an error, like the SDK does. */
export function azCliFailure(stderr: string): CredentialUnavailableError {
  const text = stderr.trim();
  const { reason, aadsts } = azFailureReason(text);
  if (reason === 'not_found') {
    return new CredentialUnavailableError(AZ_CLI_MESSAGES.notInstalled, reason);
  }
  if (/az login/.test(text) && !/az login --scope/.test(text)) {
    return new CredentialUnavailableError(
      AZ_CLI_MESSAGES.login,
      reason,
      aadsts,
    );
  }
  return new CredentialUnavailableError(
    text || AZ_CLI_MESSAGES.unknown,
    reason,
    aadsts,
  );
}

/**
 * Kill `child` and everything it started. Never throws.
 *  - Windows: `taskkill /PID <pid> /T /F`. It must run while the root is still
 *    alive (taskkill finds the tree by parent pid), so the root isn't killed
 *    first.
 *  - POSIX: the child was spawned detached (its own process group), so
 *    signalling -pid reaches the whole group.
 */
export function killProcessTree(
  child: ChildProcess,
  platform: NodeJS.Platform = process.platform,
): void {
  const pid = child.pid;
  if (platform === 'win32') {
    if (pid === undefined) return;
    try {
      const systemRoot = process.env.SystemRoot || 'C:\\Windows';
      const killer = nodeSpawn(
        path.win32.join(systemRoot, 'System32', 'taskkill.exe'),
        ['/PID', String(pid), '/T', '/F'],
        { stdio: 'ignore', windowsHide: true },
      );
      killer.on('error', () => {});
    } catch {
      // Best effort; nothing else we can do.
    }
    return;
  }
  try {
    if (pid !== undefined) {
      process.kill(-pid, 'SIGKILL');
      return;
    }
  } catch {
    // Group already gone, or not a group leader — fall back to the child.
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // Already exited.
  }
}

function safeWorkingDir(): string {
  if (process.platform === 'win32') {
    return process.env.SystemRoot || 'C:\\Windows';
  }
  return '/bin';
}

export interface AzCliCredentialOptions {
  /** Kill the `az` process tree after this many ms. */
  timeoutMs?: number;
  /** `--tenant` to pass when the caller's getToken options name none. */
  tenantId?: string;
  /**
   * The tenant is our default, not the user's choice: after a 401 a caller
   * may ask (per request) for az's current subscription tenant instead.
   */
  subscriptionTenantFallback?: boolean;
}

export class AzCliCredential implements TokenCredential {
  private readonly timeoutMs?: number;
  private readonly tenantId?: string;
  /** A request may switch to az's subscription tenant (default tenant only). */
  readonly allowsSubscriptionTenant: boolean;

  constructor(options: AzCliCredentialOptions = {}) {
    const t = options.timeoutMs;
    this.timeoutMs =
      typeof t === 'number' && Number.isInteger(t) && t > 0 ? t : undefined;
    this.tenantId = options.tenantId;
    this.allowsSubscriptionTenant =
      !!options.subscriptionTenantFallback && options.tenantId !== undefined;
  }

  async getToken(
    scopes: string | string[],
    options: GetTokenOptions = {},
  ): Promise<AccessToken> {
    const useSubscription =
      this.allowsSubscriptionTenant &&
      (options as Record<string, unknown>)[SUBSCRIPTION_TENANT] === true;
    const scope = typeof scopes === 'string' ? scopes : scopes[0];
    if (options.claims?.trim()) {
      throw new CredentialUnavailableError(AZ_CLI_MESSAGES.claims);
    }
    if (!scope || !SAFE_SCOPE.test(scope)) {
      throw new CredentialUnavailableError('Invalid scope for Azure CLI.');
    }
    // Like the SDK's AzureCliCredential: a per-request tenant wins.
    const tenantId = useSubscription
      ? undefined
      : (options.tenantId ?? this.tenantId);
    if (tenantId !== undefined && !SAFE_TENANT.test(tenantId)) {
      throw new CredentialUnavailableError('Invalid tenant for Azure CLI.');
    }
    const resource = scope.replace(/\/\.default$/, '');
    const args = [
      'account',
      'get-access-token',
      '--output',
      'json',
      '--resource',
      resource,
      ...(tenantId ? ['--tenant', tenantId] : []),
    ];
    const deadlineAt = (options as Record<string, unknown>)[AZ_DEADLINE_AT];
    return this.run(
      args,
      options.abortSignal,
      typeof deadlineAt === 'number' && Number.isFinite(deadlineAt)
        ? deadlineAt
        : undefined,
    );
  }

  private run(
    args: string[],
    signal: GetTokenOptions['abortSignal'],
    deadlineAt: number | undefined,
  ): Promise<AccessToken> {
    return new Promise<AccessToken>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new AbortError('Token request was aborted.'));
        return;
      }
      let child: ChildProcess;
      try {
        child = safeSpawn('az', args, {
          allowWindowsBatchFiles: true,
          cwd: safeWorkingDir(),
          // Own process group on POSIX so a timeout can kill the whole tree.
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (error) {
        const code = (error as { code?: unknown })?.code;
        reject(
          code === 'ENOENT'
            ? new CredentialUnavailableError(
                AZ_CLI_MESSAGES.notInstalled,
                'not_found',
              )
            : new CredentialUnavailableError(AZ_CLI_MESSAGES.unknown),
        );
        return;
      }

      const started = Date.now();
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (error: Error | null, token?: AccessToken) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve(token!);
      };
      const killAndFail = (error: Error) => {
        if (settled) return;
        killProcessTree(child);
        finish(error);
      };
      function onAbort() {
        killAndFail(new AbortError('Token request was aborted.'));
      }

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (d: string) => (stdout += d));
      child.stderr?.on('data', (d: string) => (stderr += d));
      child.on('error', (error: NodeJS.ErrnoException) => {
        finish(
          error?.code === 'ENOENT'
            ? new CredentialUnavailableError(
                AZ_CLI_MESSAGES.notInstalled,
                'not_found',
              )
            : new CredentialUnavailableError(AZ_CLI_MESSAGES.unknown),
        );
      });
      child.on('close', (code: number | null) => {
        if (settled) return;
        debugLog(
          `az get-access-token exited ${code} in ${Date.now() - started}ms`,
        );
        if (code !== 0) {
          finish(azCliFailure(stderr));
          return;
        }
        try {
          finish(null, parseAzCliTokenResponse(stdout));
        } catch (error) {
          finish(error as Error);
        }
      });

      // Our fixed bound, or — when the caller has a deadline — the bound
      // left until just before it, measured now that az has started.
      const bound =
        deadlineAt === undefined
          ? this.timeoutMs
          : Math.min(azTimeoutUntil(deadlineAt), this.timeoutMs ?? Infinity);
      if (bound !== undefined) {
        timer = setTimeout(
          () =>
            killAndFail(
              new CredentialUnavailableError(
                AZ_CLI_MESSAGES.timeout,
                'timeout',
              ),
            ),
          bound,
        );
      }
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
