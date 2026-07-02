import crypto from 'node:crypto';
import { Attributes } from '@opentelemetry/api';
import { getTelemetryMode } from './telemetry.js';
import { debugLog } from './utils.js';

/**
 * Anonymous cohort counters.
 *
 * We do NOT send any raw identity. Instead we emit one-way salted hashes of the
 * two opaque Azure GUIDs — the tenant id (company) and the object id (user) —
 * so the maintainer can count DISTINCT companies and users without being able to
 * identify them. UPN/email are never used (too low-entropy to hash safely).
 *
 * The salt is a public namespacing constant (this is open source): it can't be
 * secret and still allow cross-install distinct-counting. Hashing an opaque GUID
 * with it is one-way and not bulk-reversible; see README > Telemetry.
 */

// Bump the version suffix to rotate all hashes.
const IDENTITY_SALT = 'kusto-mcp:telemetry:v1';
// Length of the truncated hex digest. 8 = 32 bits; raise if the install base
// grows past a few thousand distinct users to avoid count collisions.
const HASH_LEN = 8;
// The shared consumer/personal Microsoft-account tenant — not a real company.
const MSA_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

let identityAttrs: Attributes = {};

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

/** Build the anonymous hash attributes from Azure token claims. */
export function buildIdentityHashes(
  claims: Record<string, unknown>,
): Attributes {
  const tid = claims.tid as string | undefined;
  const oid = claims.oid as string | undefined;
  const idtyp = claims.idtyp as string | undefined;

  // Distinguish a human user principal from an app / service principal.
  const principalType = idtyp === 'app' ? 'service_principal' : 'user';
  // Distinguish a consumer (personal MSA) account from an organization tenant.
  const accountType = tid === MSA_TENANT ? 'personal' : 'enterprise';

  const attrs: Attributes = {
    'kustomcp.principal_type': principalType,
    'kustomcp.account_type': accountType,
  };
  // Distinct-principal counter (a human user, or the app's identity for an SP).
  if (oid) attrs['kustomcp.user_hash'] = hashId(oid);
  // Only count real organizations — every consumer account shares the MSA
  // tenant, so hashing it would collapse them into one fake "company".
  if (tid && accountType !== 'personal') {
    attrs['kustomcp.company_hash'] = hashId(tid);
  }
  return attrs;
}

/** Anonymous identity attributes for the current connection. */
export function getIdentityHashAttributes(): Attributes {
  return identityAttrs;
}

export function clearIdentity(): void {
  identityAttrs = {};
}

/**
 * Acquire a token, decode only tid/oid/idtyp, and store the salted hashes. Never
 * throws — telemetry must not break a connection. No-op when telemetry or the
 * identity counters are disabled (KUSTO_MCP_TELEMETRY_IDENTITY=0).
 */
export async function captureIdentity(
  clusterUrl: string,
  getToken: (scope: string) => Promise<{ token: string } | null>,
): Promise<Attributes> {
  identityAttrs = {};
  const mode = getTelemetryMode();
  if (!mode.enabled || !mode.identityEnabled) return {};
  try {
    const origin = new URL(clusterUrl).origin;
    const tokenResponse = await getToken(`${origin}/.default`);
    if (tokenResponse?.token) {
      identityAttrs = buildIdentityHashes(decodeJwtClaims(tokenResponse.token));
      debugLog('Telemetry identity hashes captured');
    }
  } catch (error) {
    debugLog(
      `Telemetry identity capture skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return identityAttrs;
}
