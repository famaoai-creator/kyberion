import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  readCustomerDecisionOverview: vi.fn(),
  listTenantProfileSlugs: vi.fn(() => ['acme', 'globex']),
  guardRequest: vi.fn(() => null),
  requireChronosAccess: vi.fn(() => null),
  resolveViewerContextForRequest: vi.fn(),
  strictViewerScopeTenantSlugs: vi.fn(),
  strictViewerScopeProjectIds: vi.fn(),
  withViewerExecutionContext: vi.fn((_viewer: unknown, operation: () => unknown) => operation()),
  viewerErrorResponse: vi.fn(
    (error: Error, status?: number) => new Response(error.message, { status: status ?? 403 })
  ),
}));

vi.mock('../../../../lib/customer-decision-overview-facade', () => ({
  readCustomerDecisionOverview: mocks.readCustomerDecisionOverview,
}));
vi.mock('@agent/core/organization/tenant-registry', () => ({
  listTenantProfileSlugs: mocks.listTenantProfileSlugs,
}));
vi.mock('../../../../lib/api-guard', () => ({
  guardRequest: mocks.guardRequest,
  requireChronosAccess: mocks.requireChronosAccess,
}));
vi.mock('../../../../lib/viewer-context', () => ({
  resolveViewerContextForRequest: mocks.resolveViewerContextForRequest,
  strictViewerScopeTenantSlugs: mocks.strictViewerScopeTenantSlugs,
  strictViewerScopeProjectIds: mocks.strictViewerScopeProjectIds,
  withViewerExecutionContext: mocks.withViewerExecutionContext,
  viewerErrorResponse: mocks.viewerErrorResponse,
  ViewerContextError: class ViewerContextError extends Error {
    constructor(
      public readonly status: number,
      message: string
    ) {
      super(message);
    }
  },
}));

import { GET } from './route.js';
import { ViewerContextError } from '../../../../lib/viewer-context';

const URL_BASE = 'http://localhost/api/customer-decisions/overview';
const OVERVIEW = { version: '1.0.0', tenant_slug: 'acme' };
const ALL_VIEWER = { role: 'localadmin', tenantSlugs: 'all', source: 'loopback' };

describe('customer-decisions overview route (CD-12)', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.guardRequest.mockReturnValue(null);
    mocks.requireChronosAccess.mockReturnValue(null);
    mocks.resolveViewerContextForRequest.mockReturnValue({ context: ALL_VIEWER });
    mocks.strictViewerScopeProjectIds.mockReturnValue('all');
    mocks.strictViewerScopeTenantSlugs.mockReturnValue('all');
    mocks.listTenantProfileSlugs.mockReturnValue(['acme', 'globex']);
    mocks.withViewerExecutionContext.mockImplementation(
      (_viewer: unknown, operation: () => unknown) => operation()
    );
    mocks.viewerErrorResponse.mockImplementation(
      (error: Error, status?: number) => new Response(error.message, { status: status ?? 403 })
    );
    mocks.readCustomerDecisionOverview.mockResolvedValue({ ok: true, overview: OVERVIEW });
  });

  it('reads the overview of the tenant the parameter narrows an all-tenant viewer to', async () => {
    const response = await GET(new NextRequest(`${URL_BASE}?tenant=acme`));
    expect(response.status).toBe(200);
    expect(mocks.requireChronosAccess).toHaveBeenCalledWith(expect.anything(), 'readonly');
    expect(mocks.strictViewerScopeTenantSlugs).toHaveBeenCalledWith(ALL_VIEWER, 'acme');
    expect(mocks.readCustomerDecisionOverview).toHaveBeenCalledWith('acme');
    expect(await response.json()).toEqual({ overview: OVERVIEW });
  });

  it('uses the sole tenant of a tenant-scoped viewer without a parameter', async () => {
    mocks.strictViewerScopeTenantSlugs.mockReturnValue(['globex']);
    const response = await GET(new NextRequest(URL_BASE));
    expect(response.status).toBe(200);
    expect(mocks.readCustomerDecisionOverview).toHaveBeenCalledWith('globex');
  });

  it.each([
    ['an all-tenant viewer', 'all'],
    ['a multi-tenant viewer', ['acme', 'globex']],
  ])('asks %s to pick one tenant (400) and spawns nothing', async (_label, slugs) => {
    mocks.strictViewerScopeTenantSlugs.mockReturnValue(slugs);
    const response = await GET(new NextRequest(URL_BASE));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/Select one tenant/u);
    expect(mocks.readCustomerDecisionOverview).not.toHaveBeenCalled();
  });

  it('refuses a tenant outside the viewer scope before any child runs', async () => {
    mocks.strictViewerScopeTenantSlugs.mockImplementation(() => {
      throw new ViewerContextError(403, 'viewer tenant scope denied');
    });
    const response = await GET(new NextRequest(`${URL_BASE}?tenant=globex`));
    expect(response.status).toBe(403);
    expect(mocks.readCustomerDecisionOverview).not.toHaveBeenCalled();
  });

  it.each(['selected', 'grant'])('refuses %s project scope', async (mode) => {
    if (mode === 'grant') mocks.strictViewerScopeProjectIds.mockReturnValue(['PRJ-A']);
    const suffix = mode === 'selected' ? '?tenant=acme&project_id=PRJ-A' : '?tenant=acme';
    const response = await GET(new NextRequest(URL_BASE + suffix));
    expect(response.status).toBe(403);
    expect(mocks.readCustomerDecisionOverview).not.toHaveBeenCalled();
  });

  it('refuses an unregistered tenant', async () => {
    const response = await GET(new NextRequest(`${URL_BASE}?tenant=ghost`));
    expect(response.status).toBe(403);
    expect(mocks.readCustomerDecisionOverview).not.toHaveBeenCalled();
  });

  it('passes a mapped facade failure through without detail', async () => {
    mocks.readCustomerDecisionOverview.mockResolvedValue({
      ok: false,
      status: 504,
      error: 'took too long',
    });
    const response = await GET(new NextRequest(`${URL_BASE}?tenant=acme`));
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({ error: 'took too long' });
  });

  it('does not run when read-only access is denied', async () => {
    mocks.requireChronosAccess.mockReturnValue(new Response('forbidden', { status: 403 }));
    const response = await GET(new NextRequest(`${URL_BASE}?tenant=acme`));
    expect(response.status).toBe(403);
    expect(mocks.resolveViewerContextForRequest).not.toHaveBeenCalled();
    expect(mocks.readCustomerDecisionOverview).not.toHaveBeenCalled();
  });

  it('returns the viewer resolution response as is', async () => {
    mocks.resolveViewerContextForRequest.mockReturnValue({
      response: new Response('unknown token', { status: 401 }),
    });
    const response = await GET(new NextRequest(`${URL_BASE}?tenant=acme`));
    expect(response.status).toBe(401);
    expect(mocks.readCustomerDecisionOverview).not.toHaveBeenCalled();
  });
});
