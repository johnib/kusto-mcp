import crypto from 'node:crypto';
import { Attributes } from '@opentelemetry/api';
import { getTelemetryMode } from './telemetry.js';
import { debugLog } from './utils.js';

/**
 * Anonymous cohort counters.
 *
 * We do NOT send any raw identity. Instead we emit one-way salted hashes so the
 * maintainer can count DISTINCT companies and users without storing raw values:
 *   - company_hash: salted hash of the email/UPN DOMAIN (e.g. contoso.com), or
 *     the tenant id when no domain is present (e.g. service principals)
 *   - user_hash:    salted hash of the object id (an opaque GUID)
 *
 * Note: a domain is low-entropy, so company_hash is only weakly one-way — with
 * the public salt it can be reversed via a domain dictionary. See README.
 * The salt is a public namespacing constant (this is open source): it can't be
 * secret and still allow cross-install distinct-counting.
 */

// Bump the version suffix to rotate all hashes.
const IDENTITY_SALT = 'kusto-mcp:telemetry:v1';
// Length of the truncated hex digest. 8 = 32 bits; raise if the install base
// grows past a few thousand distinct users to avoid count collisions.
const HASH_LEN = 8;
// The shared consumer/personal Microsoft-account tenant — not a real company.
const MSA_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
// Public email providers — not companies; these accounts get no company_hash.
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

/** Build the anonymous hash attributes from Azure token claims. */
export function buildIdentityHashes(
  claims: Record<string, unknown>,
): Attributes {
  const tid = claims.tid as string | undefined;
  const oid = claims.oid as string | undefined;
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
  // Distinct-principal counter (a human user, or the app's identity for an SP).
  if (oid) attrs['kustomcp.user_hash'] = hashId(oid);
  // Company = the email/UPN domain when present (e.g. contoso.com), else the
  // tenant id (e.g. service principals with no email). Never for personal accounts.
  if (!isPersonal) {
    const companySource = domain ?? tid;
    if (companySource) attrs['kustomcp.company_hash'] = hashId(companySource);
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
