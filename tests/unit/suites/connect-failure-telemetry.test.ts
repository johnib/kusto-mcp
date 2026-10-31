/**
 * Bounded attributes on mcp.connection.init that say which connect step
 * failed and why: failed_step (+ms), token fetches / cache hits, the
 * credential that produced the token, the Kusto error code (allowlisted) and
 * the reachability probe result (also behind a proxy).
 */
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

let azBehavior: 'ok' | 'fail' = 'ok';
jest.mock('../../../src/auth/az-cli-credential.js', () => ({
  AzCliCredential: class AzCliCredential {
    async getToken() {
      if (azBehavior === 'fail') {
        const e = new Error('Please run az login');
        e.name = 'CredentialUnavailableError';
        throw e;
      }
      const b64 = (o: unknown) =>
        Buffer.from(JSON.stringify(o)).toString('base64url');
      return {
        token: `${b64({ alg: 'none' })}.${b64({ tid: 't', oid: 'o' })}.sig`,
        expiresOnTimestamp: Date.now() + 3600_000,
      };
    }
  },
}));

let cloudInfo: () => Promise<unknown> = async () => ({
  KustoServiceResourceId: 'https://kusto.kusto.windows.net',
  LoginMfaRequired: false,
});
let execute: () => Promise<unknown> = async () => ({});
jest.mock('azure-kusto-data', () => ({
  CloudSettings: { getCloudInfoForCluster: () => cloudInfo() },
  KustoConnectionStringBuilder: { withTokenCredential: () => 'cs' },
  Client: class {
    execute() {
      return execute();
    }
    close() {}
  },
  ClientRequestProperties: class {
    setClientTimeout() {}
  },
}));

let probeSays: string = 'reachable';
jest.mock('../../../src/common/connection-hints.js', () => ({
  ...jest.requireActual('../../../src/common/connection-hints.js'),
  probeReachability: jest.fn(
    async (_u: string, _t: number, report?: (r: string) => void) => {
      report?.(probeSays);
      return probeSays === 'dns_resolution' ? 'dns_resolution' : undefined;
    },
  ),
}));

import {
  CachingTokenCredential,
  credentialSourceOf,
} from '../../../src/auth/token-credentials.js';
import { KustoConnection } from '../../../src/operations/kusto/connection.js';
import { AuthenticationMethod } from '../../../src/types/config.js';

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});
const CLUSTER = 'https://acme.kusto.windows.net';

function httpError(status: number, code?: string) {
  return Object.assign(new Error(`HTTP ${status}`), {
    response: { status, data: code ? { error: { code } } : {} },
  });
}

async function connect() {
  exporter.reset();
  const conn = new KustoConnection({
    authMethod: AuthenticationMethod.AzureCli,
    connectionTimeout: 5000,
  });
  const err = await conn.initialize(CLUSTER, 'db').then(
    () => undefined,
    e => e as Error,
  );
  const span = exporter
    .getFinishedSpans()
    .find(s => s.name === 'mcp.connection.init')!;
  return { attrs: span.attributes, err };
}

describe('mcp.connection.init failure attributes', () => {
  beforeAll(() => provider.register());
  beforeEach(() => {
    azBehavior = 'ok';
    probeSays = 'reachable';
    cloudInfo = async () => ({
      KustoServiceResourceId: 'https://kusto.kusto.windows.net',
      LoginMfaRequired: false,
    });
    execute = async () => ({});
    delete process.env.HTTPS_PROXY;
  });

  test('success: one token fetch, from az, no failed_step', async () => {
    const { attrs, err } = await connect();
    expect(err).toBeUndefined();
    expect(attrs['kustomcp.auth.token_fetches']).toBe(1);
    expect(attrs['kustomcp.auth.token_cache_hits']).toBe(0);
    expect(attrs['kustomcp.auth.credential_used']).toBe('az');
    expect(attrs['kustomcp.connection.pipeline']).toBe('v2');
    expect(attrs).not.toHaveProperty('kustomcp.connection.failed_step');
  });

  test('token failure: failed_step=token, a fetch, no credential_used', async () => {
    azBehavior = 'fail';
    const { attrs } = await connect();
    expect(attrs['kustomcp.connection.failed_step']).toBe('token');
    expect(typeof attrs['kustomcp.connection.failed_step_ms']).toBe('number');
    expect(attrs['kustomcp.auth.token_fetches']).toBe(1);
    expect(attrs).not.toHaveProperty('kustomcp.auth.credential_used');
  });

  test('missing database: failed_step=query and the Kusto error code', async () => {
    execute = async () => {
      throw httpError(400, 'BadRequest_EntityNotFound');
    };
    const { attrs } = await connect();
    expect(attrs['kustomcp.connection.failed_step']).toBe('query');
    expect(attrs['kustomcp.connection.kusto_error_code']).toBe(
      'BadRequest_EntityNotFound',
    );
  });

  test('an unlisted Kusto error code ships as other, never the raw value', async () => {
    execute = async () => {
      throw httpError(403, 'Some_secret-db-name');
    };
    const { attrs } = await connect();
    expect(attrs['kustomcp.connection.kusto_error_code']).toBe('other');
  });

  test('metadata failure: failed_step=metadata, probe result recorded', async () => {
    cloudInfo = async () => {
      throw new Error('Failed to get cloud info for cluster');
    };
    probeSays = 'dns_resolution';
    const { attrs, err } = await connect();
    expect(attrs['kustomcp.connection.failed_step']).toBe('metadata');
    expect(attrs['kustomcp.connection.probe_result']).toBe('dns_resolution');
    expect(err!.message).toMatch(/Can't resolve the cluster host/);
  });

  test('behind a proxy the probe still runs and is recorded, but the hint stays generic', async () => {
    process.env.HTTPS_PROXY = 'http://proxy.local:8080';
    cloudInfo = async () => {
      throw new Error('Failed to get cloud info for cluster');
    };
    probeSays = 'dns_resolution';
    const { attrs, err } = await connect();
    expect(attrs['kustomcp.connection.probe_result']).toBe('dns_resolution');
    expect(attrs['kustomcp.proxy_configured']).toBe(true);
    expect(err!.message).not.toMatch(/Can't resolve the cluster host/);
  });
});

describe('credential source', () => {
  test('maps class names to a bounded enum', () => {
    class ManagedIdentityCredential {}
    class Whatever {}
    expect(credentialSourceOf(new ManagedIdentityCredential())).toBe('mi');
    expect(credentialSourceOf(new Whatever())).toBe('unknown');
    expect(credentialSourceOf(undefined)).toBe('unknown');
  });

  test('a chain reports the step that succeeded (getTokenInternal)', async () => {
    class AzurePowerShellCredential {}
    const chain = {
      getToken: jest.fn(),
      getTokenInternal: jest.fn(async () => ({
        token: { token: 'x', expiresOnTimestamp: Date.now() + 3600_000 },
        successfulCredential: new AzurePowerShellCredential(),
      })),
    };
    const cache = new CachingTokenCredential(chain);
    await cache.getToken('s');
    expect(cache.lastSource).toBe('pwsh');
    expect(chain.getToken).not.toHaveBeenCalled();
    await cache.getToken('s');
    expect(cache.stats).toEqual({ fetches: 1, hits: 1 });
  });

  test('the installed DefaultAzureCredential still exposes getTokenInternal', () => {
    const { DefaultAzureCredential } = jest.requireActual('@azure/identity');
    expect(typeof DefaultAzureCredential.prototype.getTokenInternal).toBe(
      'function',
    );
  });
});
