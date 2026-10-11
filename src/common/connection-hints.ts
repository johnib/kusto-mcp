import net from 'node:net';

/**
 * Bounded connection-failure categories (see classifyConnectionFailure). Also
 * used as a span attribute and metric label, so keep the set closed.
 */
export type ConnectionFailureCategory =
  | 'dns_resolution'
  | 'connection_refused'
  | 'tls'
  | 'timeout'
  | 'network'
  | 'http_4xx'
  | 'http_5xx'
  | 'authz'
  | 'auth'
  | 'throttled'
  | 'unknown';

export interface ConnectionHintInput {
  category: ConnectionFailureCategory;
  httpStatus?: number;
  /** Which step was running when the connect deadline fired. */
  timedOutStep?: 'token' | 'cluster';
  /** Bounded token-acquisition result from captureIdentity (no messages). */
  tokenFailed: boolean;
  authStage?: string;
  aadsts?: string;
  authMethod?: string;
  source: 'auto' | 'manual';
  clusterUrl: string;
  database: string;
  timeoutMs: number;
}

// AADSTS codes meaning the account or cluster belongs to another tenant.
const TENANT_MISMATCH_CODES = new Set(['AADSTS50020', 'AADSTS90072']);
const TENANT_LOGIN = '`az login --tenant <tenant-id>`';

function hostOf(clusterUrl: string): string {
  try {
    return new URL(clusterUrl).host;
  } catch {
    return clusterUrl;
  }
}

/**
 * Turn a classified connection failure into the failed step and one short fix
 * for the user/agent. Built only from bounded categories plus the cluster and
 * database the user configured; never from the error message. The text goes
 * into the tool result only — it is never put on a span or metric.
 */
export function connectionFailureHint(i: ConnectionHintInput): string {
  const urlSetting =
    i.source === 'auto' ? 'KUSTO_CLUSTER_URL' : 'the cluster_url argument';
  const dbSetting =
    i.source === 'auto' ? 'KUSTO_DEFAULT_DATABASE' : 'the database argument';
  const host = hostOf(i.clusterUrl);
  const waited =
    i.timeoutMs >= 1000
      ? `${Math.round(i.timeoutMs / 1000)}s`
      : `${i.timeoutMs}ms`;
  const status = i.httpStatus !== undefined ? ` (HTTP ${i.httpStatus})` : '';
  const hint = (step: string, fix: string) => `Failed step: ${step}. ${fix}`;
  const reach = 'reaching the cluster';
  const token = 'getting an Azure token';
  const database = 'opening the database';

  // A bad URL also breaks token acquisition, so network causes win.
  switch (i.category) {
    case 'dns_resolution':
      return hint(
        reach,
        `Can't resolve the cluster host ${host} – check ${urlSetting}.`,
      );
    case 'connection_refused':
      return hint(
        reach,
        `${host} refused the connection – check the host and port in ${urlSetting}.`,
      );
    case 'tls':
      return hint(
        reach,
        `TLS/certificate error talking to ${host}. If you are behind a proxy that inspects TLS, point NODE_EXTRA_CA_CERTS at its CA certificate.`,
      );
    case 'network':
      return hint(
        reach,
        `Network error talking to ${host} – check your network, VPN or proxy (HTTPS_PROXY).`,
      );
    case 'timeout':
      if (i.timedOutStep === 'token') {
        return hint(
          token,
          `No token within ${waited} – run \`az login\` again, then connect again.`,
        );
      }
      return hint(
        reach,
        `No response from ${host} within ${waited} – check your network/VPN. If the cluster is slow to start, raise KUSTO_CONNECTION_TIMEOUT.`,
      );
  }

  if (i.tokenFailed || i.category === 'auth') {
    return hint(token, tokenFix(i, host, urlSetting));
  }

  switch (i.category) {
    case 'authz':
      if (i.httpStatus === 401) {
        return hint(
          database,
          `${host} rejected your token${status}. If the cluster is in another tenant, run ${TENANT_LOGIN}.`,
        );
      }
      return hint(
        database,
        `You are signed in but have no access to database '${i.database}' on ${host}${status} – ask its admin for the Viewer role.`,
      );
    case 'http_4xx':
      return hint(
        database,
        `${host} rejected the request${status} – check that database '${i.database}' (${dbSetting}) exists; names are case-sensitive.`,
      );
    case 'http_5xx':
      return hint(
        reach,
        `${host} returned a server error${status} – the cluster may be stopped or unhealthy. Check it in the Azure portal and retry.`,
      );
    case 'throttled':
      return hint(
        reach,
        `${host} is throttling requests${status} – wait a minute and connect again.`,
      );
    default:
      return hint(
        reach,
        `Couldn't connect to ${host} – check ${urlSetting}, your network/VPN, and that \`az login\` works.`,
      );
  }
}

function tokenFix(
  i: ConnectionHintInput,
  host: string,
  urlSetting: string,
): string {
  if (i.aadsts && TENANT_MISMATCH_CODES.has(i.aadsts)) {
    return `Your account is not in the cluster's tenant (${i.aadsts}) – run ${TENANT_LOGIN} with the tenant that owns the cluster.`;
  }
  if (i.aadsts === 'AADSTS500011') {
    return `Azure AD does not know ${host} in your tenant (${i.aadsts}) – check ${urlSetting}, or run ${TENANT_LOGIN}.`;
  }
  switch (i.authStage) {
    case 'credential_unavailable':
      return i.authMethod === 'azure-cli'
        ? 'Azure CLI is not signed in (or not installed) – run `az login`, then connect again.'
        : 'No Azure credential was found – run `az login` (or set AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET for a service principal), then connect again.';
    case 'interactive_required':
    case 'conditional_access':
      return 'Your sign-in needs MFA or a fresh login – run `az login` again, then connect again.';
    case 'invalid_grant':
      return 'Your Azure sign-in expired or was revoked – run `az login` again.';
    case 'consent_required':
      return 'Your tenant requires admin consent for this sign-in – ask your Azure AD admin, then run `az login` again.';
    case 'invalid_client':
      return 'The service principal credentials were rejected – check AZURE_CLIENT_ID, AZURE_TENANT_ID and the secret or certificate.';
    case 'invalid_scope':
      return `Azure AD rejected ${host} as a token audience – check ${urlSetting}.`;
    default:
      return `Couldn't get an Azure token for ${host} – run \`az login\` (or ${TENANT_LOGIN} if the cluster is in another tenant), then connect again.`;
  }
}

/**
 * azure-kusto-data rethrows network failures from its cloud-metadata lookup as
 * a plain Error with no code, so they classify as 'unknown'. Probe the host
 * with one TCP connect and map the socket error CODE (never a message) to a
 * category. Returns undefined when the host is reachable or the probe can't
 * tell (including its own timeout). Never throws.
 */
export function probeReachability(
  clusterUrl: string,
  timeoutMs: number,
): Promise<ConnectionFailureCategory | undefined> {
  return new Promise(resolve => {
    let settled = false;
    let socket: net.Socket | undefined;
    let timer: NodeJS.Timeout | undefined;
    const done = (category?: ConnectionFailureCategory) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        socket?.destroy();
      } catch {
        /* ignore */
      }
      resolve(category);
    };
    try {
      const url = new URL(clusterUrl);
      const port = Number(url.port) || (url.protocol === 'http:' ? 80 : 443);
      const host = url.hostname.replace(/^\[|\]$/g, '');
      timer = setTimeout(() => done(undefined), timeoutMs);
      timer.unref?.();
      socket = net.connect({ host, port });
      socket.unref();
      socket.once('connect', () => done(undefined));
      socket.once('error', (err: NodeJS.ErrnoException) => {
        switch (err?.code) {
          case 'ENOTFOUND':
          case 'EAI_AGAIN':
            return done('dns_resolution');
          case 'ECONNREFUSED':
            return done('connection_refused');
          default:
            return done(undefined);
        }
      });
    } catch {
      done(undefined);
    }
  });
}
