/**
 * A connect fetches one token, not two. Before, captureIdentity asked for
 * `<cluster origin>/.default` and the SDK then asked for
 * `<KustoServiceResourceId>/.default` — different cache keys, so every connect
 * ran `az` twice (~3-4s each on Windows).
 */
import fs from 'node:fs';
import path from 'node:path';

const azRuns: string[] = [];

jest.mock('../../../src/auth/az-cli-credential.js', () => ({
  AzCliCredential: class {
    async getToken(scopes: string | string[]) {
      azRuns.push(Array.isArray(scopes) ? scopes[0] : scopes);
      const b64 = (o: unknown) =>
        Buffer.from(JSON.stringify(o)).toString('base64url');
      return {
        token: `${b64({ alg: 'none' })}.${b64({ tid: 't', oid: 'o' })}.sig`,
        expiresOnTimestamp: Date.now() + 3600_000,
      };
    }
  },
}));

let cloudInfo = {
  KustoServiceResourceId: 'https://kusto.kusto.windows.net',
  LoginMfaRequired: false,
};

// Like azure-kusto-data's TokenCredentialProvider: every request asks the
// credential for [<KustoServiceResourceId>/.default] with no tenant.
jest.mock('azure-kusto-data', () => ({
  CloudSettings: {
    getCloudInfoForCluster: async () => cloudInfo,
  },
  KustoConnectionStringBuilder: {
    withTokenCredential: (_url: string, credential: unknown) => ({
      credential,
    }),
  },
  Client: class {
    constructor(
      private cs: {
        credential: { getToken: (s: string[], o: unknown) => Promise<unknown> };
      },
    ) {}
    async execute() {
      let resource = cloudInfo.KustoServiceResourceId;
      if (cloudInfo.LoginMfaRequired)
        resource = resource.replace('.kusto.', '.kustomfa.');
      await this.cs.credential.getToken([`${resource}/.default`], {
        requestOptions: { timeout: undefined },
        tenantId: undefined,
      });
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

describe('one token fetch per connect', () => {
  beforeEach(() => {
    azRuns.length = 0;
    cloudInfo = {
      KustoServiceResourceId: 'https://kusto.kusto.windows.net',
      LoginMfaRequired: false,
    };
  });

  test('a successful connect runs az once', async () => {
    const conn = new KustoConnection({
      authMethod: AuthenticationMethod.AzureCli,
      connectionTimeout: 5000,
    });
    await conn.initialize('https://acme.westeurope.kusto.windows.net', 'db');
    expect(azRuns).toEqual(['https://kusto.kusto.windows.net/.default']);
  });

  test('an MFA cloud asks for the kustomfa audience, once', async () => {
    cloudInfo = { ...cloudInfo, LoginMfaRequired: true };
    const conn = new KustoConnection({
      authMethod: AuthenticationMethod.AzureCli,
      connectionTimeout: 5000,
    });
    await conn.initialize('https://acme.kusto.windows.net', 'db');
    expect(azRuns).toEqual(['https://kusto.kustomfa.windows.net/.default']);
  });
});

/**
 * kustoTokenScope copies how the SDK picks its scope. If the installed SDK
 * changes that, the SDK's request misses our cache and every connect runs az
 * twice again — fail here first.
 */
describe('azure-kusto-data token scope (drift guard)', () => {
  const sdk = fs.readFileSync(
    path.join(
      __dirname,
      '../../../node_modules/azure-kusto-data/dist-esm/src/tokenProvider.js',
    ),
    'utf8',
  );

  test('scope = KustoServiceResourceId (+ kustomfa) + /.default', () => {
    expect(sdk).toContain(
      'let resourceUri = this.cloudInfo.KustoServiceResourceId;',
    );
    expect(sdk).toContain(
      'resourceUri = resourceUri.replace(".kusto.", ".kustomfa.");',
    );
    expect(sdk).toContain('this.scopes = [resourceUri + "/.default"];');
  });

  test('a TokenCredential is called with no tenant', () => {
    expect(sdk).toMatch(
      /class TokenCredentialProvider extends AzureIdentityProvider \{\s*constructor\(kustoUri, tokenCredential, timeoutMs\) \{\s*super\(kustoUri, undefined, timeoutMs\);/,
    );
    expect(sdk).toContain('tenantId: this.authorityId,');
  });
});
