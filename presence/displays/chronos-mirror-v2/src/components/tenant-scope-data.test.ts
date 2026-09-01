import { describe, expect, it } from 'vitest';
import { normalizeChronosTenantScopePayload } from './tenant-scope-data';

describe('normalizeChronosTenantScopePayload', () => {
  it('normalizes valid options and drops malformed records', () => {
    expect(
      normalizeChronosTenantScopePayload({
        tenants: [
          'tenant-a',
          { slug: 'tenant-b', displayName: 'Tenant B', status: 'active' },
          null,
          { slug: 42 },
        ],
        organizations: [{ id: 'org-a', tenant_slug: 'tenant-a' }, null, { id: 7 }],
        projects: [
          { id: 'project-a', name: 'Project A', organization_id: 'org-a' },
          { id: '', name: 'ignored' },
          ['not-a-project'],
        ],
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
    expect(normalizeChronosTenantScopePayload({ tenants: [] })).toEqual({
      tenants: [],
      organizations: [],
      projects: [],
    });
  });
});
