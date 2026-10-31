/**
 * Bounded validity of the connection settings, read from the raw env values
 * BEFORE any fallback, so a typo shows up in telemetry instead of looking like
 * the default. Never the values themselves.
 */

export type SettingState = 'unset' | 'valid' | 'invalid';

/** `whitespace`: would be valid once trimmed (today it falls back). */
export type AuthMethodState = SettingState | 'whitespace';

/** `no_scheme`: a bare host such as `mycluster.kusto.windows.net`. */
export type ClusterUrlState = SettingState | 'no_scheme';

const AUTH_METHODS = new Set(['azure-identity', 'azure-cli']);

export function authMethodState(raw: string | undefined): AuthMethodState {
  if (!raw) return 'unset';
  if (AUTH_METHODS.has(raw.toLowerCase())) return 'valid';
  if (AUTH_METHODS.has(raw.trim().toLowerCase())) return 'whitespace';
  return 'invalid';
}

/** Node's setTimeout fires at ~1ms for anything above this. */
export const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** A whole number of milliseconds Node's timers accept: 1..2^31-1. */
export function timeoutState(raw: string | undefined): SettingState {
  if (raw === undefined || raw === '') return 'unset';
  const value = raw.trim();
  if (!/^\d+$/.test(value)) return 'invalid';
  const ms = Number(value);
  return Number.isSafeInteger(ms) && ms > 0 && ms <= MAX_TIMEOUT_MS
    ? 'valid'
    : 'invalid';
}

export function clusterUrlState(raw: string | undefined): ClusterUrlState {
  const value = raw?.trim();
  if (!value) return 'unset';
  try {
    const url = new URL(value);
    if ((url.protocol === 'https:' || url.protocol === 'http:') && url.host)
      return 'valid';
  } catch {
    /* not a URL */
  }
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?\/?$/i.test(value)
    ? 'no_scheme'
    : 'invalid';
}

/** Resource attributes for the connection settings in `env`. */
export function configStateAttributes(
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  return {
    'kustomcp.config.auth_method_state': authMethodState(env.KUSTO_AUTH_METHOD),
    'kustomcp.config.connection_timeout_state': timeoutState(
      env.KUSTO_CONNECTION_TIMEOUT,
    ),
    'kustomcp.config.cluster_url_state': clusterUrlState(env.KUSTO_CLUSTER_URL),
  };
}
