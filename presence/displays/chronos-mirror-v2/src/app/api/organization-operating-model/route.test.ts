import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  buildOrganizationManagementView: vi.fn(),
  resolveCompany: vi.fn(),
  guardRequest: vi.fn(() => null),
  requireChronosAccess: vi.fn(() => null),
  resolveViewerContextForRequest: vi.fn(),
  strictViewerScopeTenantSlugs: vi.fn(),
  strictViewerScopeOrganizationIds: vi.fn(),
  strictViewerScopeProjectIds: vi.fn(),
  withViewerExecutionContext: vi.fn((_viewer: unknown, operation: () => unknown) => operation()),
  viewerErrorResponse: vi.fn((error: Error) => new Response(error.message, { status: 403 })),
}));

vi.mock('@agent/core/organization/organization-operating-model-management', () => ({
  buildOrganizationManagementView: mocks.buildOrganizationManagementView,
}));

vi.mock('@agent/core/organization/tenant-registry', () => ({
  listTenantProfileSlugs: () => ['acme'],
}));

vi.mock('@agent/core/company', () => ({
  resolveCompany: mocks.resolveCompany,
}));

vi.mock('../../../lib/api-guard', () => ({
  guardRequest: mocks.guardRequest,
  requireChronosAccess: mocks.requireChronosAccess,
}));

vi.mock('../../../lib/viewer-context', () => ({
  resolveViewerContextForRequest: mocks.resolveViewerContextForRequest,
  strictViewerScopeTenantSlugs: mocks.strictViewerScopeTenantSlugs,
  strictViewerScopeOrganizationIds: mocks.strictViewerScopeOrganizationIds,
  strictViewerScopeProjectIds: mocks.strictViewerScopeProjectIds,
  withViewerExecutionContext: mocks.withViewerExecutionContext,
  viewerErrorResponse: mocks.viewerErrorResponse,
  ViewerContextError: class ViewerContextError extends Error {},
}));

import { GET } from './route.js';

describe('organization-operating-model route', () => {
  beforeEach(() => {
    mocks.buildOrganizationManagementView.mockReset();
    mocks.resolveCompany.mockReset();
    mocks.guardRequest.mockReset();
    mocks.requireChronosAccess.mockReset();
    mocks.resolveViewerContextForRequest.mockReset();
    mocks.strictViewerScopeTenantSlugs.mockReset();
    mocks.strictViewerScopeOrganizationIds.mockReset();
    mocks.strictViewerScopeProjectIds.mockReset();
    mocks.strictViewerScopeProjectIds.mockReturnValue('all');
    mocks.withViewerExecutionContext.mockReset();
    mocks.viewerErrorResponse.mockReset();
    mocks.guardRequest.mockReturnValue(null);
    mocks.requireChronosAccess.mockReturnValue(null);
    mocks.resolveViewerContextForRequest.mockReturnValue({
      context: { role: 'localadmin', tenantSlugs: 'all', source: 'loopback' },
    });
    mocks.strictViewerScopeTenantSlugs.mockReturnValue(['acme']);
    mocks.withViewerExecutionContext.mockImplementation(
      (_viewer: unknown, operation: () => unknown) => operation()
    );
    mocks.resolveCompany.mockReturnValue({
      company_id: 'acme',
      tenant_slug: 'acme',
      name: 'Acme',
    });
    mocks.buildOrganizationManagementView.mockReturnValue({
      organization_id: 'acme',
      readiness: {
        purpose: 'approved',
        operational_state: 'available',
        pending_human_decisions: 0,
      },
    });
  });

  it.each(['selected', 'grant'])(
    'blocks the full overview for %s project scope before projection',
    async (mode) => {
      if (mode === 'grant') mocks.strictViewerScopeProjectIds.mockReturnValue(['PRJ-A']);
      mocks.viewerErrorResponse.mockReturnValue(new Response('forbidden', { status: 403 }));
      const suffix = mode === 'selected' ? '?project_id=PRJ-A' : '';
      expect(
        (await GET(new NextRequest('http://localhost/api/organization-operating-model' + suffix)))
          .status
      ).toBe(403);
      expect(mocks.buildOrganizationManagementView).not.toHaveBeenCalled();
      expect(mocks.resolveCompany).not.toHaveBeenCalled();
    }
  );

  it('reads the selected organization instead of the tenant default', async () => {
    const response = await GET(
      new NextRequest(
        'http://localhost/api/organization-operating-model?tenant=acme&organization_id=ORG-A'
      )
    );
    expect(response.status).toBe(200);
    expect(mocks.strictViewerScopeOrganizationIds).toHaveBeenCalledWith(expect.anything(), 'ORG-A');
    expect(mocks.buildOrganizationManagementView).toHaveBeenCalledWith({
      organizationId: 'ORG-A',
      tier: 'confidential',
      tenantSlug: 'acme',
    });
  });

  it('does not build a projection when the selected organization is denied', async () => {
    mocks.strictViewerScopeOrganizationIds.mockImplementation(() => {
      throw new Error('denied');
    });
    mocks.viewerErrorResponse.mockReturnValue(new Response('forbidden', { status: 403 }));
    const response = await GET(
      new NextRequest('http://localhost/api/organization-operating-model?organization_id=ORG-B')
    );
    expect(response.status).toBe(403);
    expect(mocks.buildOrganizationManagementView).not.toHaveBeenCalled();
  });

  it('returns the active tenant organization projection', async () => {
    const response = await GET(
      new NextRequest('http://localhost/api/organization-operating-model')
    );

    expect(response.status).toBe(200);
    expect(mocks.requireChronosAccess).toHaveBeenCalledWith(expect.anything(), 'readonly');
    expect(mocks.resolveViewerContextForRequest).toHaveBeenCalled();
    expect(mocks.strictViewerScopeTenantSlugs).toHaveBeenCalledWith(
      { role: 'localadmin', tenantSlugs: 'all', source: 'loopback' },
      undefined
    );
    expect(mocks.withViewerExecutionContext).toHaveBeenCalledWith(
      { role: 'localadmin', tenantSlugs: 'all', source: 'loopback' },
      expect.any(Function)
    );
    expect(mocks.buildOrganizationManagementView).toHaveBeenCalledWith({
      organizationId: 'acme',
      tier: 'confidential',
      tenantSlug: 'acme',
    });
    expect(await response.json()).toMatchObject({
      view: { organization_id: 'acme' },
      tenant: { tenant_slug: 'acme' },
    });
  });

  it('does not expose the projection when localadmin access is denied', async () => {
    mocks.requireChronosAccess.mockReturnValue(new Response('forbidden', { status: 403 }));

    const response = await GET(
      new NextRequest('http://localhost/api/organization-operating-model')
    );

    expect(response.status).toBe(403);
    expect(mocks.resolveCompany).not.toHaveBeenCalled();
  });
});
