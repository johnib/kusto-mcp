/**
 * Anonymous cohort-hash tests: salted one-way hashes of tenant/object-id for
 * distinct company/user counts, user-vs-service-principal distinction, MSA
 * (personal) handling, and the identity opt-out. No raw identifier is ever
 * emitted.
 */

import {
  buildIdentityHashes,
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

describe('anonymous identity hashes', () => {
  afterEach(() => {
    clearIdentity();
    resetTelemetryModeForTests();
    delete process.env.KUSTO_MCP_TELEMETRY_IDENTITY;
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

  describe('buildIdentityHashes', () => {
    test('enterprise user -> company hash from email domain', () => {
      const a = buildIdentityHashes({
        tid: RAW_TID,
        oid: RAW_OID,
        upn: 'alice@contoso.com',
        idtyp: 'user',
      });
      expect(a['kustomcp.principal_type']).toBe('user');
      expect(a['kustomcp.account_type']).toBe('enterprise');
      expect(a['kustomcp.user_hash']).toMatch(/^[0-9a-f]{8}$/);
      expect(a['kustomcp.company_hash']).toMatch(/^[0-9a-f]{8}$/);
    });

    test('company hash is derived from the domain (same domain -> same hash)', () => {
      const a = buildIdentityHashes({ oid: 'u1', upn: 'alice@contoso.com' });
      const b = buildIdentityHashes({ oid: 'u2', upn: 'bob@contoso.com' });
      const c = buildIdentityHashes({ oid: 'u3', upn: 'carol@fabrikam.com' });
      expect(a['kustomcp.company_hash']).toBe(b['kustomcp.company_hash']); // same company
      expect(a['kustomcp.user_hash']).not.toBe(b['kustomcp.user_hash']); // different users
      expect(a['kustomcp.company_hash']).not.toBe(c['kustomcp.company_hash']); // different company
    });

    test('consumer email domain -> personal, no company hash (even in an org tenant)', () => {
      const a = buildIdentityHashes({
        tid: RAW_TID, // an enterprise tenant...
        oid: RAW_OID,
        upn: 'bob@gmail.com', // ...but a personal email
        idtyp: 'user',
      });
      expect(a['kustomcp.account_type']).toBe('personal');
      expect(a['kustomcp.company_hash']).toBeUndefined();
      expect(a['kustomcp.user_hash']).toBeDefined();
    });

    test('service principal (no domain) -> company hash falls back to tenant id', () => {
      const a = buildIdentityHashes({
        tid: RAW_TID,
        oid: 'sp-oid',
        idtyp: 'app',
      });
      expect(a['kustomcp.principal_type']).toBe('service_principal');
      expect(a['kustomcp.account_type']).toBe('enterprise');
      expect(a['kustomcp.company_hash']).toMatch(/^[0-9a-f]{8}$/);
    });

    test('personal (MSA) tenant -> no company hash, account_type=personal', () => {
      const a = buildIdentityHashes({
        tid: MSA_TENANT,
        oid: RAW_OID,
        idtyp: 'user',
      });
      expect(a['kustomcp.account_type']).toBe('personal');
      expect(a['kustomcp.principal_type']).toBe('user');
      expect(a['kustomcp.user_hash']).toBeDefined();
      expect(a['kustomcp.company_hash']).toBeUndefined();
    });

    test('hashes never equal the raw value', () => {
      const a = buildIdentityHashes({ oid: RAW_OID, upn: 'alice@contoso.com' });
      for (const v of Object.values(a)) {
        expect(v).not.toBe(RAW_OID);
        expect(v).not.toBe('contoso.com');
      }
    });

    test('distinct users produce distinct hashes', () => {
      const a = buildIdentityHashes({ oid: 'user-1' });
      const b = buildIdentityHashes({ oid: 'user-2' });
      expect(a['kustomcp.user_hash']).not.toBe(b['kustomcp.user_hash']);
    });
  });

  describe('captureIdentity gating', () => {
    const getToken = async () => ({
      token: makeJwt({ tid: RAW_TID, oid: RAW_OID, idtyp: 'user' }),
    });

    test('captures hashes when identity is enabled (default)', async () => {
      resetTelemetryModeForTests();
      const a = await captureIdentity(
        'https://help.kusto.windows.net',
        getToken,
      );
      expect(a['kustomcp.user_hash']).toBeDefined();
      expect(a['kustomcp.company_hash']).toBeDefined();
    });

    test('emits nothing when KUSTO_MCP_TELEMETRY_IDENTITY=0', async () => {
      process.env.KUSTO_MCP_TELEMETRY_IDENTITY = '0';
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
