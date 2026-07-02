/**
 * Anonymous cohort tests: salted one-way hashes of the tenant id (company_hash)
 * and object id (user_hash) for distinct company/user counts, user-vs-service-
 * principal distinction, MSA (personal) handling, and no-raw-value guarantees.
 */

import {
  buildIdentityAttributes,
  captureIdentity,
  clearIdentity,
  decodeJwtClaims,
} from '../../../src/common/identity.js';
import { resetTelemetryModeForTests } from '../../../src/common/telemetry.js';

const MSA_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';

function makeJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
}

const RAW_TID = 'contoso-tenant-guid-1234';
const RAW_OID = 'alice-object-guid-abcd';

describe('anonymous cohort identity', () => {
  afterEach(() => {
    clearIdentity();
    resetTelemetryModeForTests();
    delete process.env.KUSTO_MCP_TELEMETRY;
  });

  describe('decodeJwtClaims', () => {
    test('decodes payload without verifying', () => {
      expect(decodeJwtClaims(makeJwt({ tid: RAW_TID }))).toMatchObject({
        tid: RAW_TID,
      });
    });
    test('returns {} for malformed input', () => {
      expect(decodeJwtClaims('nope')).toEqual({});
    });
  });

  describe('buildIdentityAttributes', () => {
    test('enterprise user -> hashed company + user, principal_type=user', () => {
      const a = buildIdentityAttributes({
        tid: RAW_TID,
        oid: RAW_OID,
        idtyp: 'user',
      });
      expect(a['kustomcp.principal_type']).toBe('user');
      expect(a['kustomcp.account_type']).toBe('enterprise');
      expect(a['kustomcp.company_hash']).toMatch(/^[0-9a-f]{8}$/);
      expect(a['kustomcp.user_hash']).toMatch(/^[0-9a-f]{8}$/);
    });

    test('company_hash is derived from the tenant id (same tenant -> same hash)', () => {
      const a = buildIdentityAttributes({ tid: RAW_TID, oid: 'u1' });
      const b = buildIdentityAttributes({ tid: RAW_TID, oid: 'u2' });
      const c = buildIdentityAttributes({ tid: 'fabrikam-tenant', oid: 'u3' });
      expect(a['kustomcp.company_hash']).toBe(b['kustomcp.company_hash']); // same company
      expect(a['kustomcp.user_hash']).not.toBe(b['kustomcp.user_hash']); // different users
      expect(a['kustomcp.company_hash']).not.toBe(c['kustomcp.company_hash']); // different company
    });

    test('service principal is distinguished and still gets a company_hash', () => {
      const a = buildIdentityAttributes({
        tid: RAW_TID,
        oid: 'sp-oid',
        idtyp: 'app',
      });
      expect(a['kustomcp.principal_type']).toBe('service_principal');
      expect(a['kustomcp.company_hash']).toMatch(/^[0-9a-f]{8}$/);
    });

    test('personal (MSA) tenant -> no company_hash, account_type=personal', () => {
      const a = buildIdentityAttributes({
        tid: MSA_TENANT,
        oid: RAW_OID,
        idtyp: 'user',
      });
      expect(a['kustomcp.account_type']).toBe('personal');
      expect(a['kustomcp.company_hash']).toBeUndefined();
      expect(a['kustomcp.user_hash']).toBeDefined();
    });

    test('hashes never equal the raw values', () => {
      const a = buildIdentityAttributes({ tid: RAW_TID, oid: RAW_OID });
      expect(a['kustomcp.company_hash']).not.toBe(RAW_TID);
      expect(a['kustomcp.user_hash']).not.toBe(RAW_OID);
    });

    test('distinct users produce distinct hashes', () => {
      const a = buildIdentityAttributes({ oid: 'user-1' });
      const b = buildIdentityAttributes({ oid: 'user-2' });
      expect(a['kustomcp.user_hash']).not.toBe(b['kustomcp.user_hash']);
    });
  });

  describe('captureIdentity', () => {
    const getToken = async () => ({
      token: makeJwt({ tid: RAW_TID, oid: RAW_OID, idtyp: 'user' }),
    });

    test('captures cohort hashes when telemetry is enabled (default)', async () => {
      resetTelemetryModeForTests();
      const a = await captureIdentity(
        'https://help.kusto.windows.net',
        getToken,
      );
      expect(a['kustomcp.user_hash']).toBeDefined();
      expect(a['kustomcp.company_hash']).toBeDefined();
    });

    test('emits nothing when telemetry is disabled (KUSTO_MCP_TELEMETRY=0)', async () => {
      process.env.KUSTO_MCP_TELEMETRY = '0';
      resetTelemetryModeForTests();
      const a = await captureIdentity(
        'https://help.kusto.windows.net',
        getToken,
      );
      expect(a).toEqual({});
    });

    test('never throws when token acquisition fails', async () => {
      resetTelemetryModeForTests();
      const a = await captureIdentity(
        'https://help.kusto.windows.net',
        async () => {
          throw new Error('token failed');
        },
      );
      expect(a).toEqual({});
    });
  });
});
