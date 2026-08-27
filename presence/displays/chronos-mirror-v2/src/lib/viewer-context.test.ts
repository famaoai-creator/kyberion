import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

describe('viewer-context', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('@agent/core');
  });

  it('resolves loopback compatibility access to all tenants', async () => {
    vi.stubEnv('KYBERION_LOCALHOST_AUTOADMIN', 'true');
    vi.stubEnv('KYBERION_TRUST_PROXY', 'true');
    const { resolveViewerContext } = await import('./viewer-context.js');
    const context = resolveViewerContext(
      new NextRequest('http://localhost/api/workitems', {
        headers: { 'x-forwarded-for': '127.0.0.1' },
      })
    );
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

  it('binds an unregistered API token to the server tenant', async () => {
    vi.doMock('@agent/core', async () => ({
      ...(await vi.importActual<typeof import('@agent/core')>('@agent/core')),
      readChronosTokenRegistrations: () => [],
    }));
    vi.stubEnv('KYBERION_API_TOKEN', 'known-token');
    vi.stubEnv('KYBERION_TENANT', 'tenant-a');
    const { resolveViewerContext } = await import('./viewer-context.js');
    const context = resolveViewerContext(
      new NextRequest('https://chronos.example/api/workitems', {
        headers: { authorization: 'Bearer known-token', 'x-forwarded-for': '203.0.113.10' },
      })
    );
    expect(context).toMatchObject({
      role: 'readonly',
      tenantSlugs: ['tenant-a'],
      source: 'token',
    });
  });

  it('rejects a remote unregistered token without a server tenant', async () => {
    vi.doMock('@agent/core', async () => ({
      ...(await vi.importActual<typeof import('@agent/core')>('@agent/core')),
      readChronosTokenRegistrations: () => [],
    }));
    vi.stubEnv('KYBERION_API_TOKEN', 'known-token');
    const { resolveViewerContextForRequest } = await import('./viewer-context.js');
    const response = resolveViewerContextForRequest(
      new NextRequest('https://chronos.example/api/workitems', {
        headers: { authorization: 'Bearer known-token', 'x-forwarded-for': '203.0.113.10' },
      })
    ).response;
    expect(response?.status).toBe(403);
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

  it('keeps warn mode audit-only and never grants an unregistered tenant', async () => {
    vi.stubEnv('KYBERION_VIEWER_SCOPE', 'warn');
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

  it('cannot widen tenant or tier scope through client selections', async () => {
    const { strictViewerScopeTenantSlugs, strictViewerTier } = await import('./viewer-context.js');
    const viewer = {
      role: 'readonly' as const,
      tenantSlugs: ['tenant-a'],
      tierAccess: ['public'],
      source: 'token' as const,
    };
    const expectForbidden = (operation: () => unknown) => {
      try {
        operation();
        throw new Error('expected viewer scope denial');
      } catch (error) {
        expect(error).toMatchObject({ status: 403 });
      }
    };

    expect(strictViewerScopeTenantSlugs(viewer, 'tenant-a')).toEqual(['tenant-a']);
    expectForbidden(() => strictViewerScopeTenantSlugs(viewer, 'tenant-b'));
    expect(strictViewerTier(viewer, 'public')).toBe('public');
    expectForbidden(() => strictViewerTier(viewer, 'confidential'));
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
  it('masks personal for a registered localadmin that omits tier_access instead of rejecting it', async () => {
    const { resolveViewerTierAccess } = await import('./viewer-context.js');
    expect(resolveViewerTierAccess('localadmin')).toEqual(['confidential', 'public']);
    expect(resolveViewerTierAccess('readonly', ['public'])).toEqual(['public']);
    expect(() => resolveViewerTierAccess('localadmin', ['personal', 'public'])).toThrow(
      /exceeds the localadmin role policy/
    );
    expect(() => resolveViewerTierAccess('readonly', ['confidential', 'personal'])).toThrow(
      /exceeds the readonly role policy/
    );
  });
});
