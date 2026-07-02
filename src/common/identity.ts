import crypto from 'node:crypto';
import { Attributes } from '@opentelemetry/api';
import { getTelemetryMode } from './telemetry.js';
import { debugLog } from './utils.js';

/**
 * Anonymous cohort signals for counting distinct companies and users.
 *
 *   - company_domain: the organization's email domain (e.g. contoso.com), sent
 *     as-is. A company domain is not sensitive and only the maintainer can read
 *     the telemetry; a hash of a low-entropy domain would be reversible anyway.
 *     Consumer/personal domains and logins without an email are never sent.
 *   - user_hash: salted one-way hash of the object id (a random GUID). Hashing
 *     here is genuine — an oid is not resolvable to a person.
 *
 * The salt (for user_hash) is a public namespacing constant — it can't be secret
 * and still allow cross-install distinct-counting.
 */

// Bump the version suffix to rotate the user hashes.
const IDENTITY_SALT = 'kusto-mcp:telemetry:v1';
// Length of the truncated hex digest. 8 = 32 bits; raise if the install base
// grows past a few thousand distinct users to avoid count collisions.
const HASH_LEN = 8;
// The shared consumer/personal Microsoft-account tenant — not a real company.
const MSA_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
// Public email providers — not companies; these accounts get no company_domain.
const CONSUMER_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'hotmail.co.uk',
  'live.com',
  'msn.com',
  'yahoo.com',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'mail.com',
  'zoho.com',
  'yandex.com',
  'qq.com',
  '163.com',
]);

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
  const upn =
    (claims.upn as string) ||
    (claims.unique_name as string) ||
    (claims.preferred_username as string) ||
    (claims.email as string) ||
    undefined;
  const domain =
    typeof upn === 'string' && upn.includes('@')
      ? upn.split('@').pop()?.toLowerCase()
      : undefined;

  // Distinguish a human user principal from an app / service principal.
  const principalType = idtyp === 'app' ? 'service_principal' : 'user';
  // Personal = the shared MSA tenant or a public email provider (not a company).
  const isPersonal =
    tid === MSA_TENANT ||
    (domain !== undefined && CONSUMER_DOMAINS.has(domain));
  const accountType = isPersonal ? 'personal' : 'enterprise';

  const attrs: Attributes = {
    'kustomcp.principal_type': principalType,
    'kustomcp.account_type': accountType,
  };
  // Distinct-user counter — genuine one-way hash of the opaque object id.
  if (oid) attrs['kustomcp.user_hash'] = hashId(oid);
  // Company = the raw organization email domain (e.g. contoso.com). Never for
  // personal accounts or logins without an email (e.g. service principals).
  if (!isPersonal && domain) attrs['kustomcp.company_domain'] = domain;
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
 * Acquire a token, decode its identity claims (tenant, object id, email domain,
 * principal type), and store the salted hashes. Never throws — telemetry must not
 * break a connection. No-op when telemetry or the identity counters are disabled
 * (KUSTO_MCP_TELEMETRY_IDENTITY=0).
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
