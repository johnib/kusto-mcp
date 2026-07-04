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
  getIdentityAttributes,
} from '../../../src/common/identity.js';

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

    test('captures cohort hashes from the token', async () => {
      const a = await captureIdentity(
        'https://help.kusto.windows.net',
        getToken,
      );
      expect(a['kustomcp.user_hash']).toBeDefined();
      expect(a['kustomcp.company_hash']).toBeDefined();
      // identity_state is exposed via getIdentityAttributes, not the raw return.
      expect(getIdentityAttributes()['kustomcp.identity_state']).toBe(
        'captured',
      );
    });

    test('never throws when token acquisition fails; classifies the failure', async () => {
      const a = await captureIdentity(
        'https://help.kusto.windows.net',
        async () => {
          throw new Error('token failed');
        },
      );
      // No cohort hashes when no token resolves...
      expect(a['kustomcp.user_hash']).toBeUndefined();
      expect(a['kustomcp.company_hash']).toBeUndefined();
      // ...but the failure is classified (bounded, non-identifying).
      expect(a['kustomcp.auth.token_acquired']).toBe(false);
      expect(a['kustomcp.auth.failure_stage']).toBe('unknown');
      expect(getIdentityAttributes()['kustomcp.identity_state']).toBe(
        'unavailable',
      );
    });

    test('extracts AADSTS code + failure_stage from a structured AAD error, never a message', async () => {
      // Shape mirrors @azure/identity AuthenticationError.errorResponse.
      const authError = Object.assign(new Error('should NOT be read'), {
        name: 'AuthenticationError',
        errorResponse: {
          error: 'interaction_required',
          errorDescription: 'AADSTS50076: secret tenant detail here',
          errorCodes: [50076],
          correlationId: 'do-not-read',
        },
      });
      const a = await captureIdentity(
        'https://help.kusto.windows.net',
        async () => {
          throw authError;
        },
      );
      expect(a['kustomcp.auth.aadsts']).toBe('AADSTS50076');
      expect(a['kustomcp.auth.failure_stage']).toBe('conditional_access');
      expect(a['kustomcp.auth.token_acquired']).toBe(false);
      // No hashes, and nothing echoes the message/description/correlationId.
      for (const v of Object.values(a)) {
        if (typeof v === 'string') {
          expect(v).not.toContain('secret tenant detail');
          expect(v).not.toContain('do-not-read');
        }
      }
    });

    test('classifies credential-unavailable by class only (no message read)', async () => {
      const credErr = Object.assign(
        new Error('Azure CLI not installed / az login required — env specific'),
        { name: 'CredentialUnavailableError' },
      );
      const a = await captureIdentity(
        'https://help.kusto.windows.net',
        async () => {
          throw credErr;
        },
      );
      expect(a['kustomcp.auth.failure_stage']).toBe('credential_unavailable');
      expect(a['kustomcp.auth.aadsts']).toBeUndefined();
    });
  });
});
