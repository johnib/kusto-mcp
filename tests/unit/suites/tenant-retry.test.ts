/**
 * The az step asks for the home tenant (`organizations`). A B2B guest whose
 * cluster is in az's current subscription tenant then gets a 401 from the
 * cluster; the connect retries once with az's subscription tenant. Never when
 * the user pinned AZURE_TENANT_ID, never for a non-az token, never twice.
 */
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

const azTenants: (string | undefined)[] = [];
jest.mock('../../../src/auth/az-cli-credential.js', () => ({
  AzCliCredential: class AzCliCredential {
    private tenantId?: string;
    private canFallBack: boolean;
    constructor(o: {
      tenantId?: string;
      subscriptionTenantFallback?: boolean;
    }) {
      this.tenantId = o.tenantId;
      this.canFallBack = !!o.subscriptionTenantFallback;
    }
    fallBackToSubscriptionTenant() {
      if (!this.canFallBack || this.tenantId === undefined) return false;
      this.canFallBack = false;
      this.tenantId = undefined;
      return true;
    }
    async getToken() {
      azTenants.push(this.tenantId);
      const b64 = (o: unknown) =>
        Buffer.from(JSON.stringify(o)).toString('base64url');
      return {
        token: `${b64({})}.${b64({ tid: 't', oid: 'o' })}.s`,
        expiresOnTimestamp: Date.now() + 3600_000,
      };
    }
  },
}));

// The cluster accepts only a token minted without --tenant (subscription
// tenant), like a guest's cluster in that tenant.
let clusterAccepts: (tenant: string | undefined) => boolean = t =>
  t === undefined;
jest.mock('azure-kusto-data', () => ({
  CloudSettings: {
    getCloudInfoForCluster: async () => ({
      KustoServiceResourceId: 'https://kusto.kusto.windows.net',
      LoginMfaRequired: false,
    }),
  },
  KustoConnectionStringBuilder: { withTokenCredential: () => 'cs' },
  Client: class {
    async execute() {
      if (!clusterAccepts(azTenants.at(-1))) {
        throw Object.assign(new Error('Request failed with status 401'), {
          response: { status: 401 },
        });
      }
      return {};
    }
    close() {}
  },
  ClientRequestProperties: class {
    setClientTimeout() {}
  },
}));

import { KustoConnection } from '../../../src/operations/kusto/connection.js';
import { AuthenticationMethod } from '../../../src/types/config.js';

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
});

async function connect() {
  exporter.reset();
  const err = await new KustoConnection({
    authMethod: AuthenticationMethod.AzureCli,
    connectionTimeout: 5000,
  })
    .initialize('https://acme.kusto.windows.net', 'db')
    .then(
      () => undefined,
      e => e as Error,
    );
  const span = exporter
    .getFinishedSpans()
    .find(s => s.name === 'mcp.connection.init')!;
  return { err, attrs: span.attributes };
}

describe('401 retry from the subscription tenant', () => {
  beforeAll(() => provider.register());
  beforeEach(() => {
    azTenants.length = 0;
    clusterAccepts = t => t === undefined;
    delete process.env.AZURE_TENANT_ID;
  });

  test('a guest recovers: organizations → 401 → subscription tenant → ok', async () => {
    const { err, attrs } = await connect();
    expect(err).toBeUndefined();
    expect(azTenants).toEqual(['organizations', undefined]);
    expect(attrs['kustomcp.auth.tenant_retry']).toBe('recovered');
  });

  test('home-tenant users are untouched: one az run, no retry', async () => {
    clusterAccepts = t => t === 'organizations';
    const { err, attrs } = await connect();
    expect(err).toBeUndefined();
    expect(azTenants).toEqual(['organizations']);
    expect(attrs).not.toHaveProperty('kustomcp.auth.tenant_retry');
  });

  test('a retry that also 401s fails once, labelled failed, with the AZURE_TENANT_ID hint', async () => {
    clusterAccepts = () => false;
    const { err, attrs } = await connect();
    expect(azTenants).toEqual(['organizations', undefined]);
    expect(attrs['kustomcp.auth.tenant_retry']).toBe('failed');
    expect(err!.message).toMatch(/\(HTTP 401\).*AZURE_TENANT_ID/);
  });

  test('a pinned AZURE_TENANT_ID never retries', async () => {
    process.env.AZURE_TENANT_ID = 'contoso.onmicrosoft.com';
    clusterAccepts = () => false;
    const { attrs } = await connect();
    expect(azTenants).toEqual(['contoso.onmicrosoft.com']);
    expect(attrs).not.toHaveProperty('kustomcp.auth.tenant_retry');
  });
});
