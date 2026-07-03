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
  return identityAttrs;
}

export function clearIdentity(): void {
  identityAttrs = {};
}

/**
 * Acquire a token, decode its identity claims (tenant, object id, principal
 * type), and store the salted cohort hashes. Never throws — telemetry must not
 * break a connection.
 */
export async function captureIdentity(
  clusterUrl: string,
  getToken: (scope: string) => Promise<{ token: string } | null>,
): Promise<Attributes> {
  identityAttrs = {};
  try {
    const origin = new URL(clusterUrl).origin;
    const tokenResponse = await getToken(`${origin}/.default`);
    if (tokenResponse?.token) {
      identityAttrs = buildIdentityAttributes(
        decodeJwtClaims(tokenResponse.token),
      );
      debugLog('Telemetry identity captured');
    }
  } catch (error) {
    debugLog(
      `Telemetry identity capture skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return identityAttrs;
}
