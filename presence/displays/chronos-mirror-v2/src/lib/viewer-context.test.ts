import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { ViewerContext } from './viewer-context';

// viewer-context (and the secure-io / tier-guard / authority stack under it) is
// imported once per file and reused from the module cache; re-importing that
// stack per test with vi.resetModules() repeated its module initialisation
// every test (operations-hygiene-runbook §5). Only the tests that vi.doMock the
// token registry need a fresh module graph: they call mockRegistryModule(), and
// afterEach drops that mocked graph again so later tests re-bind the real one.
let registryMocked = false;

function mockRegistryModule(factory: () => Promise<Record<string, unknown>>): void {
  vi.resetModules();
  registryMocked = true;
  vi.doMock('@agent/core/chronos-access-registry', factory);
}

describe('viewer-context', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('@agent/core');
    vi.doUnmock('@agent/core/chronos-access-registry');
    if (registryMocked) {
      registryMocked = false;
      vi.resetModules();
    }
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
    mockRegistryModule(async () => ({
      ...(await vi.importActual<typeof import('@agent/core/chronos-access-registry')>(
        '@agent/core/chronos-access-registry'
      )),
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
    mockRegistryModule(async () => ({
      ...(await vi.importActual<typeof import('@agent/core/chronos-access-registry')>(
        '@agent/core/chronos-access-registry'
      )),
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
    const viewer: ViewerContext = {
      role: 'readonly',
      tenantSlugs: 'all',
      source: 'token',
    };
    expect(strictViewerTier(viewer, 'public')).toBe('public');
    expect(() => strictViewerTier(viewer, 'personal')).toThrow('viewer tier scope denied');
  });

  it('cannot widen tenant or tier scope through client selections', async () => {
    const { strictViewerScopeTenantSlugs, strictViewerTier } = await import('./viewer-context.js');
    const viewer: ViewerContext = {
      role: 'readonly',
      tenantSlugs: ['tenant-a'],
      tierAccess: ['public'],
      source: 'token',
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
    const viewer: ViewerContext = {
      role: 'readonly',
      tenantSlugs: ['tenant-a'],
      organizationIds: ['org-a'],
      projectIds: ['project-a'],
      source: 'token',
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
  it('TR-01: reads the token registry under the narrow reader role, not SYSTEM_ROLE', async () => {
    const { createHash, randomBytes } = await import('node:crypto');
    const token = randomBytes(24).toString('hex');
    const rolesDuringRead: string[] = [];
    mockRegistryModule(async () => {
      const actual = await vi.importActual<typeof import('@agent/core/chronos-access-registry')>(
        '@agent/core/chronos-access-registry'
      );
      const { resolveRole } = await import('@agent/core/authority');
      return {
        ...actual,
        readChronosTokenRegistrations: () => {
          rolesDuringRead.push(resolveRole() ?? '');
          return [
            {
              token_hash: createHash('sha256').update(token).digest('hex'),
              role: 'readonly',
              tenant_slugs: ['tenant-a'],
            },
          ];
        },
      };
    });
    vi.stubEnv('SYSTEM_ROLE', 'chronos_mirror_v2');
    vi.stubEnv('KYBERION_TENANT', 'tenant-a');
    const { resolveViewerContext } = await import('./viewer-context.js');
    const { resolveChronosAccessRole } = await import('./api-guard.js');
    const req = new NextRequest('https://chronos.example/api/workitems', {
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': '203.0.113.10' },
    });
    expect(resolveChronosAccessRole(req)).toBe('readonly');
    expect(resolveViewerContext(req)).toMatchObject({
      role: 'readonly',
      tenantSlugs: ['tenant-a'],
      source: 'token',
    });
    expect(rolesDuringRead.length).toBeGreaterThanOrEqual(2);
    expect(new Set(rolesDuringRead)).toEqual(new Set(['chronos_token_registry_reader']));
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
