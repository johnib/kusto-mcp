import crypto from 'node:crypto';
import { Attributes } from '@opentelemetry/api';
import { debugLog } from './utils.js';

/**
 * Anonymous cohort counters for distinct companies and users.
 *
 *   - company_hash: salted hash of the Azure tenant id (an opaque GUID).
 *   - user_hash:    salted hash of the object id (an opaque GUID).
 *
 * We never send a raw tenant id, company name, email domain, email, UPN, or
 * object id. The salt is a public namespacing constant — it can't be secret and
 * still allow cross-install distinct-counting (which also means a party holding
 * the data and a candidate id could test for its presence). `principal_type`
 * (user vs service principal) and `account_type` (personal vs enterprise) are
 * low-cardinality classifiers, not identifiers.
 */

// Bump the version suffix to rotate all hashes.
const IDENTITY_SALT = 'kusto-mcp:telemetry:v1';
// Length of the truncated hex digest. 8 = 32 bits; raise if the install base
// grows past a few thousand distinct users/companies to avoid count collisions.
const HASH_LEN = 8;
// The shared consumer/personal Microsoft-account tenant — not a real company.
const MSA_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

let identityAttrs: Attributes = {};

/**
 * Lifecycle of identity capture for the current connection:
 *   - pre_connect: no connection attempt yet (initial).
 *   - unavailable: a token acquisition was attempted but no identity resolved
 *     (auth failed, or the token had no id claims) — makes the "authenticated
 *     but unidentifiable" cohort countable instead of a silent blank.
 *   - captured: cohort hashes were derived from a token.
 */
type IdentityState = 'pre_connect' | 'captured' | 'unavailable';
let identityState: IdentityState = 'pre_connect';

// AADSTS codes for conditional-access / MFA-style failures → a stable stage.
const CONDITIONAL_ACCESS_CODES = new Set([50076, 50079, 50005, 53003, 50158]);
// Structured OAuth error identifiers (errorResponse.error) → failure stage.
const OAUTH_ERROR_STAGE: Record<string, string> = {
  interaction_required: 'interactive_required',
  consent_required: 'consent_required',
  invalid_client: 'invalid_client',
  unauthorized_client: 'invalid_client',
  invalid_grant: 'invalid_grant',
  invalid_scope: 'invalid_scope',
};

/** One-way salted hash, truncated. */
function hashId(value: string): string {
  return crypto
    .createHash('sha256')
    .update(`${IDENTITY_SALT}:${value}`)
    .digest('hex')
    .slice(0, HASH_LEN);
}

/** Decode a JWT payload WITHOUT verifying the signature (claims only). */
export function decodeJwtClaims(token: string): Record<string, unknown> {
  try {
    const payload = token.split('.')[1];
    if (!payload) return {};
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

/** Build the anonymous cohort attributes from Azure token claims. */
export function buildIdentityAttributes(
  claims: Record<string, unknown>,
): Attributes {
  const oid = claims.oid as string | undefined;
  const tid = claims.tid as string | undefined;
  const idtyp = claims.idtyp as string | undefined;

  // Distinguish a human user principal from an app / service principal.
  const principalType = idtyp === 'app' ? 'service_principal' : 'user';
  // The shared MSA tenant is consumers, not a company.
  const isPersonal = tid === MSA_TENANT;
  const accountType = isPersonal ? 'personal' : 'enterprise';

  const attrs: Attributes = {
    'kustomcp.principal_type': principalType,
    'kustomcp.account_type': accountType,
  };
  // Distinct-user counter — salted hash of the opaque object id.
  if (oid) attrs['kustomcp.user_hash'] = hashId(oid);
  // Distinct-company counter — salted hash of the tenant id (never the shared
  // consumer tenant, which would collapse all personal accounts into one).
  if (tid && !isPersonal) attrs['kustomcp.company_hash'] = hashId(tid);
  return attrs;
}

/** Anonymous cohort attributes for the current connection. */
export function getIdentityAttributes(): Attributes {
  return { ...identityAttrs, 'kustomcp.identity_state': identityState };
}

export function clearIdentity(): void {
  identityAttrs = {};
  identityState = 'pre_connect';
}

/**
 * Classify a token-acquisition failure into bounded, non-identifying cohort
 * attributes. Reads ONLY structured fields — @azure/identity's
 * `errorResponse.errorCodes` (numeric AADSTS codes) and `.error` (an OAuth error
 * identifier) — plus the error class name. It never reads any message,
 * errorDescription, correlationId, traceId, or timestamp, so nothing free-form
 * or identifying can escape. Cardinality is bounded by the enum/code sets.
 */
function classifyAuthError(error: unknown): Attributes {
  const attrs: Attributes = { 'kustomcp.auth.token_acquired': false };
  const name = error instanceof Error ? error.name : '';

  // ChainedTokenCredential aggregates each credential's failure; the first
  // AuthenticationError carries the structured AAD response.
  const inner =
    name === 'AggregateAuthenticationError'
      ? (error as { errors?: unknown[] }).errors?.[0]
      : error;
  const resp = (
    inner as {
      errorResponse?: { error?: string; errorCodes?: number[] };
    } | null
  )?.errorResponse;

  if (resp) {
    const code = Array.isArray(resp.errorCodes)
      ? resp.errorCodes[0]
      : undefined;
    // A Microsoft-published error code (app/policy state), not tenant identity.
    if (typeof code === 'number')
      attrs['kustomcp.auth.aadsts'] = `AADSTS${code}`;
    attrs['kustomcp.auth.failure_stage'] =
      (typeof code === 'number' &&
        CONDITIONAL_ACCESS_CODES.has(code) &&
        'conditional_access') ||
      (resp.error && OAUTH_ERROR_STAGE[resp.error]) ||
      'token_acquire';
    return attrs;
  }

  // Credential-unavailable (e.g. Azure CLI not installed / not logged in).
  // Classified by CLASS only — we intentionally do NOT read its message, so
  // the granularity is coarse rather than risk echoing environment specifics.
  if (name === 'CredentialUnavailableError') {
    attrs['kustomcp.auth.failure_stage'] = 'credential_unavailable';
    return attrs;
  }

  attrs['kustomcp.auth.failure_stage'] = 'unknown';
  return attrs;
}

/**
 * Acquire a token, decode its identity claims (tenant, object id, principal
 * type), and store the salted cohort hashes. Never throws — telemetry must not
 * break a connection. On failure it records a bounded, non-identifying
 * classification of WHY (see classifyAuthError) instead of a silent blank.
 */
export async function captureIdentity(
  clusterUrl: string,
  getToken: (scope: string) => Promise<{ token: string } | null>,
): Promise<Attributes> {
  identityAttrs = {};
  // A token acquisition is being attempted; downgraded to 'captured' on success.
  identityState = 'unavailable';
  try {
    const origin = new URL(clusterUrl).origin;
    const tokenResponse = await getToken(`${origin}/.default`);
    if (tokenResponse?.token) {
      identityAttrs = buildIdentityAttributes(
        decodeJwtClaims(tokenResponse.token),
      );
      identityState = 'captured';
      debugLog('Telemetry identity captured');
    }
  } catch (error) {
    identityAttrs = classifyAuthError(error);
    debugLog(
      `Telemetry identity capture failed: stage=${String(
        identityAttrs['kustomcp.auth.failure_stage'],
      )}`,
    );
  }
  return identityAttrs;
}
