import { describe, expect, it } from 'vitest';
import {
  admitsTenant,
  authorizeSurfaceOperation,
  assertSurfaceOperation,
  type SurfaceAuthorizationContext,
} from './surface-authorization.js';

const readonlyViewer: SurfaceAuthorizationContext = {
  role: 'readonly',
  tenantSlugs: ['tenant-a'],
  organizationIds: ['org-a'],
  projectIds: ['project-a'],
  tierAccess: ['public', 'confidential'],
  principalId: 'viewer-a',
  source: 'token',
};

const readOperation = {
  operationId: 'chronos.operator_home.read',
  effect: 'read' as const,
  requiredRole: 'readonly' as const,
  requiredPermissions: ['surface.headless.read' as const],
};

describe('surface authorization', () => {
  it('allows a declared read permission inside the resolved scope', () => {
    expect(
      authorizeSurfaceOperation({
        context: readonlyViewer,
        operation: readOperation,
        resource: { tenantSlug: 'tenant-a', organizationId: 'org-a', tier: 'public' },
      })
    ).toMatchObject({ allowed: true, reasonCode: 'allowed' });
  });

  it('denies a role and permission mismatch even when the route is known', () => {
    const decision = authorizeSurfaceOperation({
      context: readonlyViewer,
      operation: {
        operationId: 'chronos.work_items.update_status',
        effect: 'write',
        requiredRole: 'localadmin',
        requiredPermissions: ['surface.headless.write'],
      },
    });

    expect(decision).toMatchObject({ allowed: false, reasonCode: 'role_denied' });
  });

  it('denies tenant and tier widening independently from client filtering', () => {
    expect(
      authorizeSurfaceOperation({
        context: readonlyViewer,
        operation: readOperation,
        resource: { tenantSlug: 'tenant-b' },
      }).reasonCode
    ).toBe('tenant_scope_denied');
    expect(
      authorizeSurfaceOperation({
        context: readonlyViewer,
        operation: readOperation,
        resource: { tier: 'personal' },
      }).reasonCode
    ).toBe('tier_scope_denied');
  });

  it('fails closed when an operation omits its permission policy', () => {
    const decision = authorizeSurfaceOperation({
      context: readonlyViewer,
      operation: {
        operationId: 'surface.unknown.read',
        effect: 'read',
        requiredPermissions: [],
      },
    });

    expect(decision).toMatchObject({ allowed: false, reasonCode: 'policy_missing' });
    expect(() =>
      assertSurfaceOperation({
        context: readonlyViewer,
        operation: {
          operationId: 'surface.unknown.read',
          effect: 'read',
          requiredPermissions: [],
        },
      })
    ).toThrow('has no required permission policy');
  });

  it('fails closed when the declared permission does not match the effect', () => {
    expect(
      authorizeSurfaceOperation({
        context: readonlyViewer,
        operation: {
          operationId: 'surface.bad-write',
          effect: 'write',
          requiredPermissions: ['surface.headless.read'],
        },
      })
    ).toMatchObject({ allowed: false, reasonCode: 'policy_missing' });
  });
});

describe('admitsTenant (row-level tenant admission)', () => {
  it('admits every record for an all-tenant scope', () => {
    expect(admitsTenant({ tenantSlugs: 'all' }, 'acme')).toBe(true);
    expect(admitsTenant({ tenantSlugs: 'all' }, undefined)).toBe(true);
  });

  it('admits a company-less record only for a server-resolved includeUntenanted scope', () => {
    expect(admitsTenant({ tenantSlugs: [], includeUntenanted: true }, undefined)).toBe(true);
    expect(admitsTenant({ tenantSlugs: [], includeUntenanted: true }, '')).toBe(true);
    expect(admitsTenant({ tenantSlugs: [] }, undefined)).toBe(false);
    expect(admitsTenant({ tenantSlugs: ['acme'] }, null)).toBe(false);
  });

  it('never widens the named tenants', () => {
    expect(admitsTenant({ tenantSlugs: [], includeUntenanted: true }, 'acme')).toBe(false);
    expect(admitsTenant({ tenantSlugs: ['acme'] }, 'acme')).toBe(true);
    expect(admitsTenant({ tenantSlugs: ['acme'], includeUntenanted: true }, 'beta')).toBe(false);
  });
});
