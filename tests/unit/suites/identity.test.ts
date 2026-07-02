/**
 * Anonymous cohort tests: raw organization email domain (company_domain) for
 * distinct company counts, salted one-way hash of the object id (user_hash) for
 * distinct user counts, user-vs-service-principal distinction, MSA/consumer
 * (personal) handling, and the identity opt-out.
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

  describe('buildIdentityAttributes', () => {
    test('enterprise user -> raw company_domain + hashed user, principal_type=user', () => {
      const a = buildIdentityAttributes({
        tid: RAW_TID,
        oid: RAW_OID,
        upn: 'alice@contoso.com',
        idtyp: 'user',
      });
      expect(a['kustomcp.principal_type']).toBe('user');
      expect(a['kustomcp.account_type']).toBe('enterprise');
      expect(a['kustomcp.company_domain']).toBe('contoso.com'); // raw
      expect(a['kustomcp.user_hash']).toMatch(/^[0-9a-f]{8}$/); // hashed
    });

    test('company_domain is the raw domain; distinct users share it', () => {
      const a = buildIdentityAttributes({
        oid: 'u1',
        upn: 'alice@contoso.com',
      });
      const b = buildIdentityAttributes({ oid: 'u2', upn: 'bob@Contoso.COM' });
      expect(a['kustomcp.company_domain']).toBe('contoso.com');
      expect(b['kustomcp.company_domain']).toBe('contoso.com'); // case-normalized
      expect(a['kustomcp.user_hash']).not.toBe(b['kustomcp.user_hash']);
    });

    test('consumer email domain -> personal, no company_domain (even in an org tenant)', () => {
      const a = buildIdentityAttributes({
        tid: RAW_TID, // an enterprise tenant...
        oid: RAW_OID,
        upn: 'bob@gmail.com', // ...but a personal email
        idtyp: 'user',
      });
      expect(a['kustomcp.account_type']).toBe('personal');
      expect(a['kustomcp.company_domain']).toBeUndefined();
      expect(a['kustomcp.user_hash']).toBeDefined();
    });

    test('service principal (no email) -> no company_domain, marked service_principal', () => {
      const a = buildIdentityAttributes({
        tid: RAW_TID,
        oid: 'sp-oid',
        idtyp: 'app',
      });
      expect(a['kustomcp.principal_type']).toBe('service_principal');
      expect(a['kustomcp.company_domain']).toBeUndefined();
      expect(a['kustomcp.user_hash']).toMatch(/^[0-9a-f]{8}$/);
    });

    test('personal (MSA) tenant -> no company_domain, account_type=personal', () => {
      const a = buildIdentityAttributes({
        tid: MSA_TENANT,
        oid: RAW_OID,
        idtyp: 'user',
      });
      expect(a['kustomcp.account_type']).toBe('personal');
      expect(a['kustomcp.company_domain']).toBeUndefined();
      expect(a['kustomcp.user_hash']).toBeDefined();
    });

    test('user_hash is one-way (never the raw object id)', () => {
      const a = buildIdentityAttributes({
        oid: RAW_OID,
        upn: 'alice@contoso.com',
      });
      expect(a['kustomcp.user_hash']).not.toBe(RAW_OID);
    });

    test('distinct users produce distinct hashes', () => {
      const a = buildIdentityAttributes({ oid: 'user-1' });
      const b = buildIdentityAttributes({ oid: 'user-2' });
      expect(a['kustomcp.user_hash']).not.toBe(b['kustomcp.user_hash']);
    });
  });

  describe('captureIdentity gating', () => {
    const getToken = async () => ({
      token: makeJwt({
        tid: RAW_TID,
        oid: RAW_OID,
        upn: 'alice@contoso.com',
        idtyp: 'user',
      }),
    });

    test('captures attributes when identity is enabled (default)', async () => {
      resetTelemetryModeForTests();
      const a = await captureIdentity(
        'https://help.kusto.windows.net',
        getToken,
      );
      expect(a['kustomcp.user_hash']).toBeDefined();
      expect(a['kustomcp.company_domain']).toBe('contoso.com');
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
