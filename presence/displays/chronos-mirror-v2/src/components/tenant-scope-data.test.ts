import { describe, expect, it } from 'vitest';
import { normalizeChronosTenantScopePayload } from './tenant-scope-data';

describe('normalizeChronosTenantScopePayload', () => {
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
    });
  });

  it('rejects a primitive or missing tenant list', () => {
    expect(normalizeChronosTenantScopePayload(null)).toBeNull();
    expect(normalizeChronosTenantScopePayload({ tenants: 'tenant-a' })).toBeNull();
    expect(normalizeChronosTenantScopePayload({ ok: true, tenants: [] })).toEqual({
      tenants: [],
      organizations: [],
      projects: [],
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
