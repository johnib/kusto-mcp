/**
 * Identity extraction & consent-tier tests.
 * Verifies user/company derivation from Azure token claims + cluster URL, the
 * MSA (personal-account) suppression, and that the identity tier
 * (off | company | full) gates per-user vs company attributes correctly.
 */

import {
  buildClusterAttributes,
  buildTokenAttributes,
  captureIdentity,
  clearIdentity,
  decodeJwtClaims,
  getIdentityAttributes,
} from '../../../src/common/identity.js';
import { resetTelemetryModeForTests } from '../../../src/common/telemetry.js';

const MSA_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

function makeJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
}

const enterpriseClaims = {
  tid: 'tenant-guid-1234',
  oid: 'user-oid-abcd',
  upn: 'alice@contoso.com',
  appid: 'app-guid',
  idtyp: 'user',
};

describe('identity extraction', () => {
  afterEach(() => {
    clearIdentity();
    resetTelemetryModeForTests();
    delete process.env.KUSTO_MCP_TELEMETRY_IDENTITY;
  });

  describe('decodeJwtClaims', () => {
    test('decodes a JWT payload without verifying', () => {
      expect(decodeJwtClaims(makeJwt(enterpriseClaims))).toMatchObject({
        tid: 'tenant-guid-1234',
        upn: 'alice@contoso.com',
      });
    });

    test('returns {} for malformed input', () => {
      expect(decodeJwtClaims('not-a-jwt')).toEqual({});
      expect(decodeJwtClaims('')).toEqual({});
    });
  });

  describe('buildClusterAttributes', () => {
    test('extracts host, name and region from a regional cluster', () => {
      expect(
        buildClusterAttributes('https://contoso.westeurope.kusto.windows.net'),
      ).toEqual({
        'kusto.cluster.host': 'contoso.westeurope.kusto.windows.net',
        'kusto.cluster.name': 'contoso',
        'kusto.cluster.region': 'westeurope',
      });
    });

    test('no region label for help cluster', () => {
      const attrs = buildClusterAttributes('https://help.kusto.windows.net');
      expect(attrs['kusto.cluster.name']).toBe('help');
      expect(attrs['kusto.cluster.region']).toBeUndefined();
    });
  });

  describe('buildTokenAttributes', () => {
    test('enterprise account -> company + user attrs', () => {
      const a = buildTokenAttributes(enterpriseClaims);
      expect(a).toMatchObject({
        'enduser.tenant.id': 'tenant-guid-1234',
        'enduser.account_type': 'enterprise',
        'enduser.upn_domain': 'contoso.com',
        'enduser.id': 'user-oid-abcd',
        'enduser.upn': 'alice@contoso.com',
      });
    });

    test('personal (MSA) account suppresses upn_domain as company signal', () => {
      const a = buildTokenAttributes({
        tid: MSA_TENANT,
        oid: 'oid',
        upn: 'bob@gmail.com',
        idtyp: 'user',
      });
      expect(a['enduser.account_type']).toBe('personal');
      expect(a['enduser.upn_domain']).toBeUndefined();
      expect(a['enduser.upn']).toBe('bob@gmail.com');
    });

    test('service principal has no upn', () => {
      const a = buildTokenAttributes({
        tid: 'tenant',
        oid: 'sp-oid',
        appid: 'app',
        idtyp: 'app',
      });
      expect(a['enduser.account_type']).toBe('service_principal');
      expect(a['enduser.upn']).toBeUndefined();
      expect(a['enduser.id']).toBe('sp-oid');
    });
  });

  describe('identity tier gating', () => {
    const capture = () =>
      captureIdentity(
        'https://contoso.westeurope.kusto.windows.net',
        'MyDb',
        async () => ({ token: makeJwt(enterpriseClaims) }),
      );

    test('full tier exposes per-user + company + region', async () => {
      process.env.KUSTO_MCP_TELEMETRY_IDENTITY = 'full';
      resetTelemetryModeForTests();
      await capture();
      const a = getIdentityAttributes();
      expect(a['enduser.id']).toBe('user-oid-abcd');
      expect(a['enduser.upn']).toBe('alice@contoso.com');
      expect(a['enduser.tenant.id']).toBe('tenant-guid-1234');
      expect(a['kusto.cluster.host']).toBeDefined();
    });

    test('company tier drops per-user, keeps company', async () => {
      process.env.KUSTO_MCP_TELEMETRY_IDENTITY = 'company';
      resetTelemetryModeForTests();
      await capture();
      const a = getIdentityAttributes();
      expect(a['enduser.id']).toBeUndefined();
      expect(a['enduser.upn']).toBeUndefined();
      expect(a['enduser.tenant.id']).toBe('tenant-guid-1234');
      expect(a['kusto.cluster.host']).toBe(
        'contoso.westeurope.kusto.windows.net',
      );
    });

    test('off tier keeps only region', async () => {
      process.env.KUSTO_MCP_TELEMETRY_IDENTITY = 'off';
      resetTelemetryModeForTests();
      await capture();
      const a = getIdentityAttributes();
      expect(a['enduser.tenant.id']).toBeUndefined();
      expect(a['enduser.id']).toBeUndefined();
      expect(a['kusto.cluster.host']).toBeUndefined();
      expect(a['kusto.cluster.name']).toBeUndefined();
      expect(a['kusto.cluster.region']).toBe('westeurope');
    });

    test('token acquisition failure does not throw; cluster attrs still set', async () => {
      process.env.KUSTO_MCP_TELEMETRY_IDENTITY = 'full';
      resetTelemetryModeForTests();
      await captureIdentity(
        'https://help.kusto.windows.net',
        'DB',
        async () => {
          throw new Error('token failed');
        },
      );
      const a = getIdentityAttributes();
      expect(a['kusto.cluster.host']).toBe('help.kusto.windows.net');
      expect(a['enduser.tenant.id']).toBeUndefined();
    });
  });
});
