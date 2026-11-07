import { describe, expect, it } from 'vitest';
import {
  admitsCustody,
  admitsScopeAudience,
  admitsTenant,
  authorizeSurfaceOperation,
  assertSurfaceOperation,
  custodyOfScope,
  viewerPersonIds,
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

describe('admitsCustody (P4 — custody-kind row admission)', () => {
  it('tenant custody follows the same rule admitsTenant always had', () => {
    expect(admitsCustody({ tenantSlugs: 'all' }, { kind: 'tenant', ref: 'acme' })).toBe(true);
    expect(admitsCustody({ tenantSlugs: ['acme'] }, { kind: 'tenant', ref: 'acme' })).toBe(true);
    expect(admitsCustody({ tenantSlugs: ['acme'] }, { kind: 'tenant', ref: 'beta' })).toBe(false);
    expect(
      admitsCustody({ tenantSlugs: [], includeUntenanted: true }, { kind: 'tenant', ref: 'acme' })
    ).toBe(false);
  });

  it('system custody is what untenanted always meant', () => {
    expect(admitsCustody({ tenantSlugs: 'all' }, { kind: 'system' })).toBe(true);
    expect(admitsCustody({ tenantSlugs: [], includeUntenanted: true }, { kind: 'system' })).toBe(
      true
    );
    expect(admitsCustody({ tenantSlugs: [] }, { kind: 'system' })).toBe(false);
    expect(admitsCustody({ tenantSlugs: ['acme'] }, { kind: 'system' })).toBe(false);
  });

  it('person custody is identity-bound — tenant scope never admits it', () => {
    const person = { kind: 'person' as const, ref: 'human:owner' };
    expect(admitsCustody({ tenantSlugs: 'all' }, person)).toBe(false);
    expect(admitsCustody({ tenantSlugs: ['acme'], includeUntenanted: true }, person)).toBe(false);
    expect(admitsCustody({ tenantSlugs: [], principalId: 'human:owner' }, person)).toBe(true);
    expect(admitsCustody({ tenantSlugs: [], memberId: 'member-x' }, person)).toBe(false);
    expect(admitsCustody({ tenantSlugs: [], personIds: ['human:owner'] }, person)).toBe(true);
    // Another person's records stay closed even to an all-tenant viewer.
    expect(
      admitsCustody(
        { tenantSlugs: 'all', principalId: 'human:owner' },
        { kind: 'person', ref: 'human:other' }
      )
    ).toBe(false);
  });

  it('custodyOfScope derives tenant > person > system from record fields', () => {
    expect(custodyOfScope({ tenant_slug: 'acme' })).toEqual({ kind: 'tenant', ref: 'acme' });
    // A tenant binding wins over a person marker on the same record.
    expect(custodyOfScope({ tenant_slug: 'acme', owner_nhi: 'human:x' })).toEqual({
      kind: 'tenant',
      ref: 'acme',
    });
    expect(custodyOfScope({ owner_nhi: 'human:x' })).toEqual({ kind: 'person', ref: 'human:x' });
    // `nhi_id` is the governed (event-scope) person-binding field — one
    // binding vocabulary with owner_nhi (approval-review-scope equivalence).
    expect(custodyOfScope({ nhi_id: 'human:x' })).toEqual({ kind: 'person', ref: 'human:x' });
    expect(custodyOfScope({ tenant_slug: 'acme', nhi_id: 'human:x' })).toEqual({
      kind: 'tenant',
      ref: 'acme',
    });
    expect(custodyOfScope({})).toEqual({ kind: 'system' });
    expect(custodyOfScope(null)).toEqual({ kind: 'system' });
    expect(custodyOfScope(undefined)).toEqual({ kind: 'system' });
  });

  it('viewerPersonIds resolves member, principal, and carried person ids', () => {
    expect(viewerPersonIds({ memberId: 'member-a', principalId: 'human:a' }).sort()).toEqual([
      'human:a',
      'member-a',
    ]);
    expect(viewerPersonIds({ personIds: ['human:x'] })).toEqual(['human:x']);
    expect(viewerPersonIds({})).toEqual([]);
  });

  it('admitsScopeAudience: audience grants admit by identity on person custody only', () => {
    const shared = {
      owner_nhi: 'human:owner',
      allowed_audience: ['human:peer'],
    };
    // The owner and a listed audience member are admitted — by identity.
    expect(admitsScopeAudience({ tenantSlugs: [], principalId: 'human:owner' }, shared)).toBe(true);
    expect(admitsScopeAudience({ tenantSlugs: ['acme'], memberId: 'human:peer' }, shared)).toBe(
      true
    );
    // 'all' admits neither — person custody is never scope-bound.
    expect(admitsScopeAudience({ tenantSlugs: 'all' }, shared)).toBe(false);
    expect(admitsScopeAudience({ tenantSlugs: ['acme'] }, shared)).toBe(false);
    // Audience grants nothing on tenant or system custody.
    expect(
      admitsScopeAudience({ tenantSlugs: [], includeUntenanted: true }, { allowed_audience: ['x'] })
    ).toBe(true); // system custody via includeUntenanted, audience irrelevant
    expect(
      admitsScopeAudience({ tenantSlugs: [] }, { tenant_slug: 'acme', allowed_audience: ['x'] })
    ).toBe(false); // tenant custody not in scope — audience grants nothing
  });
});
