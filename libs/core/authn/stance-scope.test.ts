import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  InvalidStanceSelectionError,
  StanceNotPermittedError,
  narrowViewerScopeToStance,
  parseStanceSelection,
  resolveStance,
  stanceResourceBinding,
} from './stance-resolver.js';
import { resolveSurfaceViewerScope } from '../surface/surface-mutation-guard.js';
import {
  currentResourceAccessScope,
  resourceAccessDenial,
  runInResourceAccessScope,
} from '../foundation/resource-access-scope.js';

/**
 * Concept Model v2 D4: a stance is the acting-for selection. Switching it
 * switches the data scope a viewer / request ceiling reflects, and it can
 * never widen beyond the tenants the operator is permitted to serve.
 */

function fdeViewer() {
  // An FDE whose credential registration permits two customer tenants.
  return resolveSurfaceViewerScope({
    token: 'fde-token',
    registrations: [
      {
        token_hash: createHash('sha256').update('fde-token').digest('hex'),
        role: 'readonly',
        tenant_slugs: ['tenant-a', 'tenant-b'],
        organization_ids: ['delivery-a', 'delivery-b'],
        label: 'fde',
      },
    ],
  });
}

describe('stance selection', () => {
  it('resolves a permitted tenant with its Organization and Org Role', () => {
    const stance = resolveStance({
      permittedTenants: ['tenant-a', 'tenant-b'],
      selection: { tenantSlug: 'tenant-a', organizationId: 'delivery-a', orgRole: 'pm' },
    });
    expect(stance.permittedTenants).toEqual(['tenant-a', 'tenant-b']);
    expect(stance.selected).toEqual({
      tenantSlug: 'tenant-a',
      organizationId: 'delivery-a',
      orgRole: 'pm',
    });
  });

  it('rejects a tenant outside the permitted list', () => {
    expect(() =>
      resolveStance({ permittedTenants: ['tenant-a'], selection: { tenantSlug: 'tenant-c' } })
    ).toThrow(StanceNotPermittedError);
    expect(() =>
      resolveStance({ permittedTenants: [], selection: { tenantSlug: 'tenant-a' } })
    ).toThrow('[STANCE_NOT_PERMITTED]');
  });

  it('rejects reserved and malformed selections', () => {
    for (const tenantSlug of ['shared', 'public', 'Tenant A', '../x', ''])
      expect(
        () => resolveStance({ permittedTenants: 'all', selection: { tenantSlug } }),
        tenantSlug
      ).toThrow(InvalidStanceSelectionError);
    expect(() =>
      resolveStance({
        permittedTenants: 'all',
        selection: { tenantSlug: 'tenant-a', orgRole: 'Bad Role' },
      })
    ).toThrow('[STANCE_SELECTION_INVALID]');
  });

  it('parses acting_for from stance.json and treats a missing declaration as none', () => {
    expect(parseStanceSelection({ slug: 'x' })).toBeNull();
    expect(
      parseStanceSelection({
        acting_for: { tenant_slug: 'tenant-b', organization_id: 'delivery-b', org_role: 'pm' },
      })
    ).toEqual({ tenantSlug: 'tenant-b', organizationId: 'delivery-b', orgRole: 'pm' });
    expect(() => parseStanceSelection({ acting_for: { tenant_slug: 7 } })).toThrow(
      InvalidStanceSelectionError
    );
  });
});

describe('stance switch and the viewer scope', () => {
  it('narrows the viewer to the selected tenant and organization, and switching moves it', () => {
    const viewer = fdeViewer();
    expect(viewer.tenantSlugs).toEqual(['tenant-a', 'tenant-b']);

    const actingForA = narrowViewerScopeToStance(viewer, {
      tenantSlug: 'tenant-a',
      organizationId: 'delivery-a',
    });
    expect(actingForA.tenantSlugs).toEqual(['tenant-a']);
    expect(actingForA.organizationIds).toEqual(['delivery-a']);
    expect(actingForA.role).toBe(viewer.role);
    expect(actingForA.tierAccess).toEqual(viewer.tierAccess);

    const actingForB = narrowViewerScopeToStance(viewer, { tenantSlug: 'tenant-b' });
    expect(actingForB.tenantSlugs).toEqual(['tenant-b']);
    expect(actingForB.organizationIds).toEqual(['delivery-a', 'delivery-b']);
  });

  it('cannot widen beyond the tenants and organizations the credential grants', () => {
    const viewer = fdeViewer();
    expect(() => narrowViewerScopeToStance(viewer, { tenantSlug: 'tenant-c' })).toThrow(
      StanceNotPermittedError
    );
    expect(() =>
      narrowViewerScopeToStance(viewer, { tenantSlug: 'tenant-a', organizationId: 'other-org' })
    ).toThrow('[STANCE_NOT_PERMITTED]');
    // Once narrowed to tenant A, a further switch to B is outside the narrowed scope.
    const actingForA = narrowViewerScopeToStance(viewer, { tenantSlug: 'tenant-a' });
    expect(() => narrowViewerScopeToStance(actingForA, { tenantSlug: 'tenant-b' })).toThrow(
      StanceNotPermittedError
    );
  });

  it('narrows an unbound local operator to exactly one tenant', () => {
    const local = resolveSurfaceViewerScope({
      local: true,
      allowLoopback: true,
      loopbackRole: 'localadmin',
    });
    expect(local.tenantSlugs).toBe('all');
    expect(narrowViewerScopeToStance(local, { tenantSlug: 'tenant-a' }).tenantSlugs).toEqual([
      'tenant-a',
    ]);
  });
});

describe('stance switch and the ResourceAccessScope ceiling', () => {
  const readA = 'knowledge/confidential/tenant-a/notes.md';
  const readB = 'knowledge/confidential/tenant-b/notes.md';

  function ceilingFor(tenant: 'tenant-a' | 'tenant-b') {
    const stance = resolveStance({
      permittedTenants: ['tenant-a', 'tenant-b'],
      selection: { tenantSlug: tenant, organizationId: `delivery-${tenant.slice(-1)}` },
    });
    return {
      ...stanceResourceBinding(stance),
      readExact: [tenant === 'tenant-a' ? readA : readB],
      writeExact: [],
      mkdirExact: [],
    };
  }

  it('binds the request ceiling to the selected tenant, and switching moves the binding', () => {
    runInResourceAccessScope(ceilingFor('tenant-a'), () => {
      expect(currentResourceAccessScope()).toMatchObject({
        custody: { kind: 'tenant' },
        tenantSlug: 'tenant-a',
        organizationId: 'delivery-a',
      });
      expect(resourceAccessDenial(readA, 'read')).toBeNull();
      expect(resourceAccessDenial(readB, 'read')).not.toBeNull();
    });
    runInResourceAccessScope(ceilingFor('tenant-b'), () => {
      expect(currentResourceAccessScope()?.tenantSlug).toBe('tenant-b');
      expect(resourceAccessDenial(readB, 'read')).toBeNull();
      expect(resourceAccessDenial(readA, 'read')).not.toBeNull();
    });
  });

  it('cannot switch to another tenant inside a stance-bound request', () => {
    runInResourceAccessScope(ceilingFor('tenant-a'), () => {
      expect(() => runInResourceAccessScope(ceilingFor('tenant-b'), () => undefined)).toThrow(
        '[RESOURCE_SCOPE_INVALID] Nested resource bindings cannot change'
      );
    });
  });
});
