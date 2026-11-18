import { AuthenticationMethod } from '../types/config.js';
import { clusterUrlState, MAX_TIMEOUT_MS } from './config-state.js';

/**
 * Read connection settings from the environment, repairing the safe
 * mistakes and reporting the rest, instead of silently misbehaving: a NaN
 * timeout fires in ~1ms (#288), and a mistyped auth method silently fell
 * back to the default (#289). Each warning is a short sentence the user sees
 * on stderr and in a failed connect's message.
 */

/** Add `https://` to a bare cluster host; leave anything else as it is. */
export function withScheme(clusterUrl: string): string {
  const value = clusterUrl.trim();
  return clusterUrlState(value) === 'no_scheme' ? `https://${value}` : value;
}

/**
 * A whole number of milliseconds within `min`..`max`, or undefined (use the
 * default) with a warning when the value is set but unusable.
 */
export function parseIntSetting(
  name: string,
  raw: string | undefined,
  warnings: string[],
  { min = 1, max = MAX_TIMEOUT_MS }: { min?: number; max?: number } = {},
): number | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  const n = /^\d+$/.test(value) ? Number(value) : NaN;
  if (Number.isSafeInteger(n) && n >= min && n <= max) return n;
  warnings.push(
    `${name}="${value}" is not a whole number between ${min} and ${max}; using the default.`,
  );
  return undefined;
}

/** KUSTO_AUTH_METHOD, trimmed; an unknown value falls back with a warning. */
export function parseAuthMethod(
  raw: string | undefined,
  warnings: string[],
): AuthenticationMethod {
  const value = raw?.trim().toLowerCase();
  if (!value || value === 'azure-identity')
    return AuthenticationMethod.AzureIdentity;
  if (value === 'azure-cli') return AuthenticationMethod.AzureCli;
  warnings.push(
    `KUSTO_AUTH_METHOD="${raw}" is not azure-identity or azure-cli; using azure-identity.`,
  );
  return AuthenticationMethod.AzureIdentity;
}

const TRUE_VALUES = ['true', '1', 'yes', 'on', 'y', 'enabled'];
const FALSE_VALUES = ['false', '0', 'no', 'off', 'n', 'disabled'];

/**
 * A boolean flag. Case, whitespace and quote characters are ignored, and an
 * inline `# comment` is dropped (Docker `--env-file` keeps both in the value).
 * Unset or empty gives `unset`; any other unrecognised value gives `unknown`,
 * with a warning (#287).
 */
export function parseBoolSetting(
  name: string,
  raw: string | undefined,
  warnings: string[],
  { unset, unknown }: { unset: boolean; unknown: boolean },
): boolean {
  const value = (raw ?? '')
    .replace(/["']/g, '')
    .split('#')[0]
    .trim()
    .toLowerCase();
  if (!value) return unset;
  if (TRUE_VALUES.includes(value)) return true;
  if (FALSE_VALUES.includes(value)) return false;
  warnings.push(
    `${name}=${JSON.stringify(raw?.trim())} is not one of ${TRUE_VALUES.join(', ')} or ` +
      `${FALSE_VALUES.join(', ')}; using ${unknown}.`,
  );
  return unknown;
}
