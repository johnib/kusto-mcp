/**
 * Why `az` gave no token. Every az failure used to be one class
 * (CredentialUnavailableError) and one label (credential_unavailable), and
 * azCliFailure replaced any stderr mentioning "az login" before an AADSTS
 * code could be read — so expired, MFA, tenant and not-installed all got the
 * same hint. Now a bounded az_reason (+ AADSTS digits) is parsed from the raw
 * stderr first, exported, and picks the hint.
 */
import {
  azCliFailure,
  azFailureReason,
} from '../../../src/auth/az-cli-credential.js';
import { connectionFailureHint } from '../../../src/common/connection-hints.js';
import {
  captureIdentity,
  clearIdentity,
} from '../../../src/common/identity.js';

const EXPIRED_WITH_SCOPE =
  'ERROR: AADSTS700082: The refresh token has expired due to inactivity. The token was issued on 2026-06-01T08:00:00Z and was inactive for 90.00:00:00. Trace ID: 0000 Correlation ID: 1111 Timestamp: 2026-10-01 10:00:00Z\nInteractive authentication is needed. Please run:\naz login --scope https://kusto.kusto.windows.net/.default';
const EXPIRED_PLAIN_LOGIN =
  "ERROR: AADSTS700082: The refresh token has expired due to inactivity.\nPlease run 'az login' to setup account.";

describe('azFailureReason', () => {
  test.each([
    [
      "ERROR: Please run 'az login' to setup account.",
      'not_logged_in',
      undefined,
    ],
    [EXPIRED_WITH_SCOPE, 'expired', '700082'],
    [EXPIRED_PLAIN_LOGIN, 'expired', '700082'],
    [
      "'az' is not recognized as an internal or external command,\r\noperable program or batch file.",
      'not_found',
      undefined,
    ],
    ['/bin/sh: 1: az: not found', 'not_found', undefined],
    [
      'ERROR: AADSTS50076: Due to a configuration change made by your administrator, or because you moved to a new location, you must use multi-factor authentication to access the resource.',
      'mfa_required',
      '50076',
    ],
    [
      "ERROR: AADSTS50020: User account 'x@contoso.com' from identity provider 'live.com' does not exist in tenant 'Fabrikam'.",
      'tenant',
      '50020',
    ],
    ['ERROR: AADSTS12345: Something new.', 'other', '12345'],
    ['ERROR: boom', 'other', undefined],
  ])('%#: %s', (stderr, reason, aadsts) => {
    expect(azFailureReason(stderr)).toEqual({
      reason,
      ...(aadsts && { aadsts }),
    });
  });

  test('azCliFailure keeps the reason even when it rewrites the message', () => {
    const e = azCliFailure(EXPIRED_PLAIN_LOGIN);
    expect(e.message).toMatch(/Please run 'az login'/);
    expect(e.azReason).toBe('expired');
    expect(e.aadstsCode).toBe('700082');
    expect(e.name).toBe('CredentialUnavailableError');
  });
});

describe('telemetry attributes', () => {
  beforeEach(() => clearIdentity());

  const failWith = (error: unknown) =>
    captureIdentity('s', async () => {
      throw error;
    });

  test('a single az failure → az_reason + aadsts', async () => {
    const attrs = await failWith(azCliFailure(EXPIRED_WITH_SCOPE));
    expect(attrs).toMatchObject({
      'kustomcp.auth.token_acquired': false,
      'kustomcp.auth.failure_stage': 'credential_unavailable',
      'kustomcp.auth.az_reason': 'expired',
      'kustomcp.auth.aadsts': 'AADSTS700082',
    });
  });

  test('inside the default chain (AggregateAuthenticationError)', async () => {
    const env = Object.assign(new Error('env'), {
      name: 'CredentialUnavailableError',
    });
    const agg = Object.assign(new Error('chain'), {
      name: 'AggregateAuthenticationError',
      errors: [env, azCliFailure("'az' is not recognized as a command")],
    });
    const attrs = await failWith(agg);
    expect(attrs['kustomcp.auth.az_reason']).toBe('not_found');
    expect(attrs['kustomcp.auth.failure_stage']).toBe('credential_unavailable');
  });

  test('a foreign error with a free-form azReason exports nothing for it', async () => {
    const attrs = await failWith(
      Object.assign(new Error('x'), {
        name: 'CredentialUnavailableError',
        azReason: 'user@corp.example',
        aadstsCode: '50020; drop',
      }),
    );
    expect(attrs).not.toHaveProperty('kustomcp.auth.az_reason');
    expect(attrs).not.toHaveProperty('kustomcp.auth.aadsts');
  });

  test("aadsts stays az's own when a later chain step has another code", async () => {
    const aad = Object.assign(new Error('aad'), {
      name: 'AuthenticationError',
      errorResponse: { error: 'interaction_required', errorCodes: [50076] },
    });
    const agg = Object.assign(new Error('chain'), {
      name: 'AggregateAuthenticationError',
      errors: [azCliFailure(EXPIRED_WITH_SCOPE), aad],
    });
    const attrs = await failWith(agg);
    expect(attrs['kustomcp.auth.az_reason']).toBe('expired');
    expect(attrs['kustomcp.auth.aadsts']).toBe('AADSTS700082');
  });

  test('hostile stderr: only the enum and digits leave', async () => {
    const attrs = await failWith(
      azCliFailure(
        'ERROR: AADSTS99999999 user@corp.com tenant 72f988bf-86f1-41af-91ab-2d7cd011db47 <script>',
      ),
    );
    const allowed = new Set([
      'kustomcp.auth.token_acquired',
      'kustomcp.auth.failure_stage',
      'kustomcp.auth.az_reason',
      'kustomcp.auth.aadsts',
    ]);
    for (const [k, v] of Object.entries(attrs)) {
      expect(allowed.has(k)).toBe(true);
      expect(String(v)).not.toMatch(/@|corp|72f988bf|script/);
    }
    expect(attrs['kustomcp.auth.aadsts']).toMatch(/^AADSTS\d{5,6}$/);
  });
});

describe('the hint follows the az reason', () => {
  const base = {
    category: 'auth' as const,
    tokenFailed: true,
    authStage: 'credential_unavailable',
    authMethod: 'azure-cli',
    source: 'manual' as const,
    clusterUrl: 'https://acme.kusto.windows.net',
    database: 'db',
    timeoutMs: 20000,
  };

  test.each([
    ['not_found', undefined, /not installed or not on PATH – install it/],
    ['not_logged_in', undefined, /Azure CLI is not signed in – run `az login`/],
    ['expired', 'AADSTS700082', /expired or was revoked \(AADSTS700082\)/],
    [
      'mfa_required',
      'AADSTS50076',
      /needs MFA or a fresh login \(AADSTS50076\)/,
    ],
    [
      'timeout',
      undefined,
      /did not return a token in time – check that `az account get-access-token/,
    ],
    ['bad_response', undefined, /unexpected response – update it/],
  ])('%s', (azReason, aadsts, expected) => {
    expect(connectionFailureHint({ ...base, azReason, aadsts })).toMatch(
      expected,
    );
  });

  test('no az reason keeps the old credential_unavailable hint', () => {
    expect(connectionFailureHint(base)).toMatch(
      /Azure CLI is not signed in \(or not installed\)/,
    );
  });
});
