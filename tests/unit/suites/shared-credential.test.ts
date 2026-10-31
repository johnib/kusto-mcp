/**
 * One credential (and token cache) is shared by every connection in the
 * process. That sharing must not leak one connection's state into another:
 * - a token a query got 401 for is dropped, so a reconnect gets a new one;
 * - a guest cluster's subscription-tenant retry doesn't change the tenant a
 *   later connection to a home-tenant cluster uses;
 * - overlapping requests each count their own fetches/hits and source.
 */
const azRuns: string[] = [];
let azGeneration = 0;
jest.mock('../../../src/auth/az-cli-credential.js', () => ({
  AzCliCredential: class AzCliCredential {
    readonly allowsSubscriptionTenant = true;
    async getToken(_s: unknown, options?: Record<string, unknown>) {
      const tenant = options?.kustoMcpSubscriptionTenant
        ? 'subscription'
        : 'organizations';
      azRuns.push(tenant);
      return {
        token: `${tenant}#${++azGeneration}`,
        expiresOnTimestamp: Date.now() + 3600_000,
      };
    }
  },
}));

// Each cluster accepts tokens from one tenant; `revoked` tokens get 401.
const revoked = new Set<string>();
const accepts: Record<string, string> = {
  'https://home.kusto.windows.net': 'organizations',
  'https://guest.kusto.windows.net': 'subscription',
};
jest.mock('azure-kusto-data', () => ({
  CloudSettings: {
    getCloudInfoForCluster: async () => ({
      KustoServiceResourceId: 'https://kusto.kusto.windows.net',
      LoginMfaRequired: false,
    }),
  },
  KustoConnectionStringBuilder: {
    withTokenCredential: (url: string, credential: unknown) => ({
      url,
      credential,
    }),
  },
  Client: class {
    constructor(
      private cs: {
        url: string;
        credential: {
          getToken: (s: string[]) => Promise<{ token: string } | null>;
        };
      },
    ) {}
    async execute() {
      const t = await this.cs.credential.getToken([
        'https://kusto.kusto.windows.net/.default',
      ]);
      const token = t?.token ?? '';
      if (revoked.has(token) || !token.startsWith(accepts[this.cs.url]))
        throw Object.assign(new Error('401'), { response: { status: 401 } });
      return {};
    }
    close() {}
  },
  ClientRequestProperties: class {
    setClientTimeout() {}
    setTimeout() {}
  },
}));

import { OBSERVE, TokenObservation } from '../../../src/auth/observe.js';
import {
  CachingTokenCredential,
  createTokenCredential,
} from '../../../src/auth/token-credentials.js';
import { KustoConnection } from '../../../src/operations/kusto/connection.js';
import { AuthenticationMethod } from '../../../src/types/config.js';

const config = {
  authMethod: AuthenticationMethod.AzureCli,
  connectionTimeout: 5000,
};

beforeEach(() => {
  azRuns.length = 0;
  revoked.clear();
});

test('a query 401 drops the token: the next connect fetches a new one', async () => {
  const shared = createTokenCredential('azure-cli', 5000);
  const first = new KustoConnection(config, shared);
  await first.initialize('https://home.kusto.windows.net', 'db');
  expect(azRuns).toHaveLength(1);

  // The token is revoked; a query now gets 401.
  revoked.add('organizations#' + azGeneration);
  await expect(first.executeQuery('db', 'print 1')).rejects.toThrow();

  // After `az login`, one reconnect is enough.
  await new KustoConnection(config, shared).initialize(
    'https://home.kusto.windows.net',
    'db',
  );
  expect(azRuns).toHaveLength(2);
});

test('a guest connect does not change the tenant of a later home connect', async () => {
  const shared = createTokenCredential('azure-cli', 5000);
  await new KustoConnection(config, shared).initialize(
    'https://home.kusto.windows.net',
    'db',
  );
  await new KustoConnection(config, shared).initialize(
    'https://guest.kusto.windows.net',
    'db',
  );
  // Home again: still the home tenant (from the cache), no 401.
  await new KustoConnection(config, shared).initialize(
    'https://home.kusto.windows.net',
    'db',
  );
  expect(azRuns).toEqual(['organizations', 'subscription']);
});

test('overlapping requests each count their own fetch or hit', async () => {
  let release!: (v: unknown) => void;
  const inner = {
    getToken: () =>
      new Promise(r => {
        release = r;
      }),
  };
  const cache = new CachingTokenCredential(
    inner as unknown as ConstructorParameters<typeof CachingTokenCredential>[0],
  );
  const a: TokenObservation = { fetches: 0, hits: 0 };
  const b: TokenObservation = { fetches: 0, hits: 0 };
  const pa = cache.getToken('s', { [OBSERVE]: a } as never);
  const pb = cache.getToken('s', { [OBSERVE]: b } as never);
  release({ token: 't', expiresOnTimestamp: Date.now() + 3600_000 });
  await Promise.all([pa, pb]);
  expect(a).toMatchObject({ fetches: 1, hits: 0 });
  expect(b).toMatchObject({ fetches: 0, hits: 1 });
  expect(a.source).toBeDefined();
  expect(b.source).toBe(a.source);
});
