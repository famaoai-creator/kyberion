import { describe, expect, it } from 'vitest';
import { isDiscussionVisibleToViewer, resolveDiscussionCreateScope } from './discussion-access';
import type { ViewerContext } from './ops-viewer';

function viewer(overrides: Partial<ViewerContext>): ViewerContext {
  return {
    role: 'localadmin',
    tenantSlugs: 'all',
    organizationIds: 'all',
    projectIds: 'all',
    tierAccess: ['public', 'confidential'],
    source: 'token',
    ...overrides,
  };
}

describe('discussion visibility', () => {
  it('enforces tier and effective read permission independently of owner/tenant admission', () => {
    const owner = viewer({ principalId: 'owner', tenantSlugs: ['acme'], tierAccess: ['public'] });
    for (const binding of [{ tenant_slug: 'acme' }, { owner_nhi: 'owner' }]) {
      expect(isDiscussionVisibleToViewer(owner, { ...binding, tier: 'public' })).toBe(true);
      expect(isDiscussionVisibleToViewer(owner, { ...binding, tier: 'confidential' })).toBe(false);
      expect(isDiscussionVisibleToViewer(owner, binding as never)).toBe(false);
      expect(isDiscussionVisibleToViewer(owner, { ...binding, tier: 'invalid' as never })).toBe(
        false
      );
      expect(
        isDiscussionVisibleToViewer({ ...owner, permissions: [] }, { ...binding, tier: 'public' })
      ).toBe(false);
    }
  });
  it('applies a tenant selection after system and person admission', () => {
    const owner = viewer({ principalId: 'owner', includeUntenanted: true });
    for (const scope of [{}, { owner_nhi: 'owner' }]) {
      expect(
        isDiscussionVisibleToViewer(
          owner,
          scope as Parameters<typeof isDiscussionVisibleToViewer>[1]
        )
      ).toBe(true);
      expect(
        isDiscussionVisibleToViewer(
          owner,
          scope as Parameters<typeof isDiscussionVisibleToViewer>[1],
          'acme'
        )
      ).toBe(false);
    }
    expect(isDiscussionVisibleToViewer(owner, { tenant_slug: 'acme' }, 'acme')).toBe(true);
  });
  it('shows every room to an unrestricted viewer', () => {
    expect(isDiscussionVisibleToViewer(viewer({}), {})).toBe(true);
    expect(isDiscussionVisibleToViewer(viewer({}), { tenant_slug: 'acme' })).toBe(true);
  });

  it('limits a tenant-scoped viewer to their tenant and hides unscoped rooms', () => {
    const scoped = viewer({ tenantSlugs: ['acme'] });
    expect(isDiscussionVisibleToViewer(scoped, { tenant_slug: 'acme' })).toBe(true);
    expect(isDiscussionVisibleToViewer(scoped, { tenant_slug: 'other' })).toBe(false);
    expect(isDiscussionVisibleToViewer(scoped, {})).toBe(false);
  });

  it('never lets a client-supplied tenant widen the viewer scope', () => {
    const scoped = viewer({ tenantSlugs: ['acme'] });
    expect(() => isDiscussionVisibleToViewer(scoped, { tenant_slug: 'other' }, 'other')).toThrow();
  });

  it('applies organization and project grants', () => {
    const scoped = viewer({ organizationIds: ['org-1'], projectIds: ['proj-1'] });
    expect(
      isDiscussionVisibleToViewer(scoped, { organization_id: 'org-1', project_id: 'proj-1' })
    ).toBe(true);
    expect(isDiscussionVisibleToViewer(scoped, { organization_id: 'org-2' })).toBe(false);
    expect(isDiscussionVisibleToViewer(scoped, { organization_id: 'org-1' })).toBe(false);
  });
});

describe('discussion create scope', () => {
  it('stamps the only tenant a scoped viewer holds', () => {
    expect(resolveDiscussionCreateScope(viewer({ tenantSlugs: ['acme'] }))).toEqual({
      tenant_slug: 'acme',
    });
  });

  it('refuses ambiguity for a multi-tenant viewer', () => {
    expect(() => resolveDiscussionCreateScope(viewer({ tenantSlugs: ['a', 'b'] }))).toThrow();
  });

  it('honours a requested tenant for an unrestricted viewer', () => {
    expect(resolveDiscussionCreateScope(viewer({}), 'acme')).toEqual({ tenant_slug: 'acme' });
  });
});
