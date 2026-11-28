import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { withStoreGrant } from '../authority.js';
import { validateReadPermission, validateWritePermission } from '../tier-guard.js';

vi.mock('../governance/audit-chain.js', () => ({ auditChain: { record: vi.fn() } }));

// The standing-grant store lives in a tier-partitioned durable-state root
// (active/shared/runtime/grants/<tier>/<tenant>/). credential_allocation_store
// is granted it by its real path; the knowledge-tier projection of that path
// must not hide the grant (first approved assign could never be applied).
const tenant = 'grant-fixture-a';
const other = 'grant-fixture-b';
const partition = (slug: string) =>
  path.join(pathResolver.rootDir(), `active/shared/runtime/grants/confidential/${slug}`);

const asManager = <T>(fn: () => T): T =>
  withStoreGrant('credential_allocation_store', fn, { tenantSlug: tenant });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('credential_allocation_store on the grant store partition', () => {
  it('writes and reads its own bound tenant partition', () => {
    vi.stubEnv('KYBERION_TENANT', tenant);
    asManager(() => {
      expect(validateWritePermission(partition(tenant), 'mkdir')).toEqual({ allowed: true });
      expect(
        validateWritePermission(
          path.join(partition(tenant), 'GRT-20261128-abcdef123456.json'),
          'write'
        )
      ).toEqual({
        allowed: true,
      });
      expect(validateReadPermission(partition(tenant))).toEqual({ allowed: true });
      expect(
        validateReadPermission(path.join(partition(tenant), 'GRT-20261128-abcdef123456.json'))
      ).toEqual({
        allowed: true,
      });
    });
  });

  it('never reaches another tenant partition', () => {
    vi.stubEnv('KYBERION_TENANT', tenant);
    asManager(() => {
      expect(
        validateWritePermission(
          path.join(partition(other), 'GRT-20261128-abcdef123456.json'),
          'write'
        ).allowed
      ).toBe(false);
      expect(
        validateReadPermission(path.join(partition(other), 'GRT-20261128-abcdef123456.json'))
          .allowed
      ).toBe(false);
    });
  });

  it('refuses to open when no tenant is bound', () => {
    vi.stubEnv('KYBERION_TENANT', '');
    expect(() => withStoreGrant('credential_allocation_store', () => undefined)).toThrow(
      /ROLE_TENANT_SCOPE_REQUIRED/
    );
  });

  it('does not widen other stores to the grant store', () => {
    vi.stubEnv('KYBERION_TENANT', tenant);
    withStoreGrant('personal_connections_store', () => {
      expect(
        validateWritePermission(
          path.join(partition(tenant), 'GRT-20261128-abcdef123456.json'),
          'write'
        ).allowed
      ).toBe(false);
    });
  });
});
