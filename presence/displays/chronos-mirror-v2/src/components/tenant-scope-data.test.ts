import { describe, expect, it } from 'vitest';
import { normalizeChronosTenantScopePayload } from './tenant-scope-data';

describe('normalizeChronosTenantScopePayload', () => {
  it('accepts organization-owned operations without inventing a project parent', () => {
    const operation = {
      id: 'daily',
      name: 'Daily review',
      tenant_slug: 'acme',
      organization_id: 'sales',
    };
    expect(
      normalizeChronosTenantScopePayload({ ok: true, tenants: [], operations: [operation] })
        ?.operations
    ).toEqual([operation]);
    expect(
      normalizeChronosTenantScopePayload({
        ok: true,
        tenants: [],
        operations: [{ ...operation, name: 42 }],
      })
    ).toBeNull();
  });
  it('normalizes valid options without accepting malformed records', () => {
    expect(
      normalizeChronosTenantScopePayload({
        ok: true,
        tenants: ['tenant-a', { slug: 'tenant-b', displayName: 'Tenant B', status: 'active' }],
        organizations: [{ id: 'org-a', tenant_slug: 'tenant-a' }],
        projects: [{ id: 'project-a', name: 'Project A', organization_id: 'org-a' }],
      })
    ).toEqual({
      tenants: [
        { slug: 'tenant-a', displayName: 'tenant-a' },
        { slug: 'tenant-b', displayName: 'Tenant B', status: 'active' },
      ],
      organizations: [{ id: 'org-a', tenant_slug: 'tenant-a' }],
      projects: [{ id: 'project-a', name: 'Project A', organization_id: 'org-a' }],
      operations: [],
    });
  });

  it('rejects a primitive or missing tenant list', () => {
    expect(normalizeChronosTenantScopePayload(null)).toBeNull();
    expect(normalizeChronosTenantScopePayload({ tenants: 'tenant-a' })).toBeNull();
    expect(normalizeChronosTenantScopePayload({ ok: true, tenants: [] })).toEqual({
      tenants: [],
      organizations: [],
      projects: [],
      operations: [],
    });
  });

  it('fails closed for malformed entries, unsafe keys, and denied responses', () => {
    expect(
      normalizeChronosTenantScopePayload({ ok: true, tenants: [{ slug: 'tenant-a' }, null] })
    ).toBeNull();
    expect(
      normalizeChronosTenantScopePayload({
        ok: true,
        tenants: [{ slug: 'tenant-a', displayName: 42 }],
      })
    ).toBeNull();
    expect(normalizeChronosTenantScopePayload({ ok: false, tenants: [] })).toBeNull();
    expect(
      normalizeChronosTenantScopePayload(
        JSON.parse('{"ok":true,"tenants":[],"__proto__":{"polluted":true}}')
      )
    ).toBeNull();
  });
});
