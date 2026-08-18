import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

describe('viewer-context', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => vi.unstubAllEnvs());

  it('resolves loopback compatibility access to all tenants', async () => {
    vi.stubEnv('KYBERION_LOCALHOST_AUTOADMIN', 'true');
    const { resolveViewerContext } = await import('./viewer-context.js');
    const context = resolveViewerContext(new NextRequest('http://localhost/api/workitems'));
    expect(context).toMatchObject({ role: 'localadmin', tenantSlugs: 'all', source: 'loopback' });
  });

  it('rejects an unknown supplied token instead of falling through to loopback access', async () => {
    vi.stubEnv('KYBERION_LOCALHOST_AUTOADMIN', 'true');
    vi.stubEnv('KYBERION_API_TOKEN', 'known-token');
    const { resolveViewerContextForRequest } = await import('./viewer-context.js');
    const response = resolveViewerContextForRequest(
      new NextRequest('http://localhost/api/workitems', {
        headers: { authorization: 'Bearer unknown-token' },
      })
    ).response;
    expect(response?.status).toBe(401);
  });

  it('enforces tenant selection when rollout mode is enforce', async () => {
    vi.stubEnv('KYBERION_VIEWER_SCOPE', 'enforce');
    const { viewerScopeTenantSlugs } = await import('./viewer-context.js');
    expect(() =>
      viewerScopeTenantSlugs(
        { role: 'readonly', tenantSlugs: ['tenant-a'], source: 'token' },
        'tenant-b'
      )
    ).toThrow(/tenant-b/);
  });

  it('rejects tier names as requested viewer tenants', async () => {
    const { viewerScopeTenantSlugs } = await import('./viewer-context.js');
    expect(() =>
      viewerScopeTenantSlugs(
        { role: 'localadmin', tenantSlugs: 'all', source: 'loopback' },
        'public'
      )
    ).toThrow(/invalid viewer tenant scope/i);
  });

  it('does not allow a viewer registration to widen the role tier policy', async () => {
    const { resolveViewerTierAccess } = await import('./viewer-context.js');
    expect(resolveViewerTierAccess('readonly', ['public', 'confidential'])).toEqual([
      'public',
      'confidential',
    ]);
    expect(() => resolveViewerTierAccess('readonly', ['personal'])).toThrow(
      'exceeds the readonly role policy'
    );
  });

  it('denies a data route from selecting a tier outside the resolved viewer scope', async () => {
    const { strictViewerTier } = await import('./viewer-context.js');
    const viewer = { role: 'readonly' as const, tenantSlugs: 'all', source: 'token' as const };
    expect(strictViewerTier(viewer, 'public')).toBe('public');
    expect(() => strictViewerTier(viewer, 'personal')).toThrow('viewer tier scope denied');
  });

  it('only allows organization and project selections inside the registered sets', async () => {
    const { strictViewerScopeOrganizationIds, strictViewerScopeProjectIds } =
      await import('./viewer-context.js');
    const viewer = {
      role: 'readonly' as const,
      tenantSlugs: ['tenant-a'],
      organizationIds: ['org-a'],
      projectIds: ['project-a'],
      source: 'token' as const,
    };

    expect(strictViewerScopeOrganizationIds(viewer, 'org-a')).toEqual(['org-a']);
    expect(strictViewerScopeProjectIds(viewer, 'project-a')).toEqual(['project-a']);
    expect(() => strictViewerScopeOrganizationIds(viewer, 'org-b')).toThrow(
      'viewer organization scope denied'
    );
    expect(() => strictViewerScopeProjectIds(viewer, 'project-b')).toThrow(
      'viewer project scope denied'
    );
  });
});
