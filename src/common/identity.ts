import { Attributes } from '@opentelemetry/api';
import { getTelemetryMode } from './telemetry.js';
import { debugLog } from './utils.js';

/**
 * Telemetry identity extraction.
 *
 * kusto-mcp already holds an Azure TokenCredential (see auth/token-credentials.ts).
 * The access token it mints for the target cluster is a JWT whose (unverified,
 * decode-only) payload identifies WHO uses the package and for WHICH company:
 *   - tid   -> Azure AD tenant id            == the organization/company
 *   - upn/email domain                        == the company (human-readable)
 *   - cluster hostname                        == the company
 *   - oid   -> stable per-user object id      == the user
 *   - upn   -> user principal name            == the user
 *
 * What actually ships is gated by the identity tier (off | company | full);
 * see telemetry.ts. Company-level identity answers "which organization"; the
 * per-user fields (`enduser.id`, `enduser.upn`) are the `full` tier only.
 */

// Consumer/personal Microsoft-account home tenant. Its "domain" (gmail.com etc.)
// is not a company, so we suppress domain-as-company for these accounts.
const MSA_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

// Per-user identifiers — only emitted at the `full` tier.
const USER_KEYS = new Set(['enduser.id', 'enduser.upn']);
// Region is not organization-identifying — allowed even at the `off` tier.
const REGION_KEYS = new Set(['kusto.cluster.region']);

/** Full (ungated) identity attributes for the current connection. */
let currentIdentity: Attributes = {};

/** Decode a JWT payload WITHOUT verifying the signature (identity claims only). */
export function decodeJwtClaims(token: string): Record<string, unknown> {
  try {
    const payload = token.split('.')[1];
    if (!payload) return {};
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

/** Cluster identity derivable from the URL alone (no token needed). */
export function buildClusterAttributes(clusterUrl: string): Attributes {
  const attrs: Attributes = {};
  try {
    const host = new URL(clusterUrl).hostname;
    const labels = host.split('.');
    attrs['kusto.cluster.host'] = host;
    attrs['kusto.cluster.name'] = labels[0];
    // e.g. contoso.westeurope.kusto.windows.net -> region "westeurope";
    // help.kusto.windows.net has no region label.
    if (labels.length >= 4 && !['kusto', 'fabric'].includes(labels[1])) {
      attrs['kusto.cluster.region'] = labels[1];
    }
  } catch {
    attrs['kusto.cluster.host'] = clusterUrl;
  }
  return attrs;
}

/** Identity attributes derived from Azure token claims. */
export function buildTokenAttributes(
  claims: Record<string, unknown>,
): Attributes {
  const upn =
    (claims.upn as string) ||
    (claims.unique_name as string) ||
    (claims.preferred_username as string) ||
    (claims.email as string) ||
    undefined;
  const domain =
    upn && upn.includes('@') ? upn.split('@').pop()?.toLowerCase() : undefined;

  const accountType =
    claims.idtyp === 'app'
      ? 'service_principal'
      : claims.tid === MSA_TENANT
        ? 'personal'
        : 'enterprise';

  const attrs: Attributes = {
    'enduser.tenant.id': claims.tid as string,
    'enduser.account_type': accountType,
    'azure.app_id': claims.appid as string,
    'azure.identity_type': claims.idtyp as string,
  };
  // Personal accounts: domain (gmail.com/outlook.com) is not a company signal.
  if (accountType !== 'personal' && domain)
    attrs['enduser.upn_domain'] = domain;
  // Per-user identifiers (full tier only, sliced later).
  attrs['enduser.id'] = claims.oid as string;
  if (accountType !== 'service_principal') attrs['enduser.upn'] = upn;

  for (const k of Object.keys(attrs)) {
    if (attrs[k] === undefined || attrs[k] === null) delete attrs[k];
  }
  return attrs;
}

/** Slice the full identity down to what the configured tier permits. */
function sliceByTier(full: Attributes): Attributes {
  const tier = getTelemetryMode().identity;
  if (tier === 'full') return { ...full };
  const out: Attributes = {};
  for (const [k, v] of Object.entries(full)) {
    if (tier === 'off') {
      if (REGION_KEYS.has(k)) out[k] = v;
    } else {
      // company: everything except per-user keys
      if (!USER_KEYS.has(k)) out[k] = v;
    }
  }
  return out;
}

/** Identity attributes for the current connection, gated by the tier. */
export function getIdentityAttributes(): Attributes {
  return sliceByTier(currentIdentity);
}

/** Low-cardinality identity labels for metrics (never per-user). */
export function getMetricIdentityLabels(): Attributes {
  const tier = getTelemetryMode().identity;
  if (tier === 'off') return {};
  const labels: Attributes = {};
  if (currentIdentity['enduser.tenant.id'])
    labels['enduser.tenant.id'] = currentIdentity['enduser.tenant.id'];
  if (currentIdentity['kusto.cluster.host'])
    labels['kusto.cluster.host'] = currentIdentity['kusto.cluster.host'];
  return labels;
}

export function clearIdentity(): void {
  currentIdentity = {};
}

/**
 * Capture identity for a connection. Computes cluster attributes from the URL
 * immediately, then best-effort decodes the access token for user/tenant. Never
 * throws — telemetry must not break a connection. Returns the gated slice for
 * immediate span stamping (also stored for later tool spans).
 */
export async function captureIdentity(
  clusterUrl: string,
  database: string,
  getToken: (scope: string) => Promise<{ token: string } | null>,
): Promise<Attributes> {
  const full: Attributes = { ...buildClusterAttributes(clusterUrl) };
  if (database) full['kusto.database'] = database;
  try {
    const origin = new URL(clusterUrl).origin;
    const tokenResponse = await getToken(`${origin}/.default`);
    if (tokenResponse?.token) {
      Object.assign(
        full,
        buildTokenAttributes(decodeJwtClaims(tokenResponse.token)),
      );
      debugLog(
        `Telemetry identity captured for tenant=${full['enduser.tenant.id']}`,
      );
    }
  } catch (error) {
    debugLog(
      `Telemetry identity capture skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  currentIdentity = full;
  return sliceByTier(full);
}
