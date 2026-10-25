import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const ref = (exists: boolean) => ({ path: 'x', exists, data: null });
const company = (tenant: string, recorded = true) => ({
  company_id: `org-${tenant}`,
  tenant_slug: tenant,
  customer_ref: ref(recorded),
  identity_ref: ref(false),
  organization_profile_ref: ref(false),
});

const mocks = vi.hoisted(() => ({
  readCustomerDecisionOverview: vi.fn(),
  listTenantProfileSlugs: vi.fn(() => ['acme', 'globex']),
  guardRequest: vi.fn(() => null),
  requireChronosAccess: vi.fn(() => null),
  resolveViewerContextForRequest: vi.fn(),
  strictViewerScopeTenantSlugs: vi.fn(),
  strictViewerScopeProjectIds: vi.fn(),
  strictViewerScopeOrganizationIds: vi.fn(),
  strictViewerTier: vi.fn(),
  resolveCompany: vi.fn((tenant: string) => ({ company_id: `org-${tenant}`, tenant_slug: tenant })),
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
vi.mock('@agent/core/company', () => ({ resolveCompany: mocks.resolveCompany }));
vi.mock('../../../../lib/api-guard', () => ({
  guardRequest: mocks.guardRequest,
  requireChronosAccess: mocks.requireChronosAccess,
}));
vi.mock('../../../../lib/viewer-context', () => ({
  resolveViewerContextForRequest: mocks.resolveViewerContextForRequest,
  strictViewerScopeTenantSlugs: mocks.strictViewerScopeTenantSlugs,
  strictViewerScopeProjectIds: mocks.strictViewerScopeProjectIds,
  strictViewerScopeOrganizationIds: mocks.strictViewerScopeOrganizationIds,
  strictViewerTier: mocks.strictViewerTier,
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
import { companyIdMemo, createCompanyIdMemo } from './company-memo';
import type { CompanyAggregate } from '@agent/core/company';
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
    mocks.strictViewerTier.mockReturnValue('confidential');
    mocks.strictViewerScopeOrganizationIds.mockReturnValue('all');
    mocks.resolveCompany.mockImplementation((tenant: string) => company(tenant));
    companyIdMemo.clear();
  });

  it('checks the confidential tier and the tenant organization before reading', async () => {
    const response = await GET(new NextRequest(`${URL_BASE}?tenant=acme`));
    expect(response.status).toBe(200);
    expect(mocks.strictViewerTier).toHaveBeenCalledWith(ALL_VIEWER, 'confidential');
    expect(mocks.resolveCompany).toHaveBeenCalledWith('acme');
    expect(mocks.strictViewerScopeOrganizationIds).toHaveBeenCalledWith(ALL_VIEWER, 'org-acme');
    const order = (mock: { mock: { invocationCallOrder: number[] } }) =>
      mock.mock.invocationCallOrder[0];
    expect(order(mocks.strictViewerTier)).toBeLessThan(order(mocks.readCustomerDecisionOverview));
    expect(order(mocks.strictViewerScopeOrganizationIds)).toBeLessThan(
      order(mocks.readCustomerDecisionOverview)
    );
  });

  it('refuses a viewer without confidential tier access (no child, no cache)', async () => {
    mocks.strictViewerTier.mockImplementation(() => {
      throw new ViewerContextError(403, 'viewer tier scope denied');
    });
    const response = await GET(new NextRequest(`${URL_BASE}?tenant=acme`));
    expect(response.status).toBe(403);
    expect(mocks.readCustomerDecisionOverview).not.toHaveBeenCalled();
  });

  it("refuses a viewer outside the tenant's organization", async () => {
    mocks.strictViewerScopeOrganizationIds.mockImplementation(() => {
      throw new ViewerContextError(403, 'viewer organization scope denied');
    });
    const response = await GET(new NextRequest(`${URL_BASE}?tenant=acme`));
    expect(response.status).toBe(403);
    expect(mocks.readCustomerDecisionOverview).not.toHaveBeenCalled();
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

  it('memoizes only the company lookup; every authorization check still runs per request', async () => {
    for (let i = 0; i < 3; i += 1) {
      expect((await GET(new NextRequest(`${URL_BASE}?tenant=acme`))).status).toBe(200);
    }
    expect(mocks.resolveCompany).toHaveBeenCalledTimes(1);
    expect(mocks.strictViewerScopeTenantSlugs).toHaveBeenCalledTimes(3);
    expect(mocks.listTenantProfileSlugs).toHaveBeenCalledTimes(3);
    expect(mocks.strictViewerTier).toHaveBeenCalledTimes(3);
    expect(mocks.strictViewerScopeOrganizationIds).toHaveBeenCalledTimes(3);
    expect(mocks.strictViewerScopeOrganizationIds).toHaveBeenLastCalledWith(ALL_VIEWER, 'org-acme');
    // A memoized company does not let another viewer past its organization scope …
    mocks.strictViewerScopeOrganizationIds.mockImplementation(() => {
      throw new ViewerContextError(403, 'viewer organization scope denied');
    });
    expect((await GET(new NextRequest(`${URL_BASE}?tenant=acme`))).status).toBe(403);
    // … nor past the tier, nor a tenant that left the registry.
    mocks.strictViewerScopeOrganizationIds.mockReturnValue('all');
    mocks.strictViewerTier.mockImplementation(() => {
      throw new ViewerContextError(403, 'viewer tier scope denied');
    });
    expect((await GET(new NextRequest(`${URL_BASE}?tenant=acme`))).status).toBe(403);
    mocks.strictViewerTier.mockReturnValue('confidential');
    mocks.listTenantProfileSlugs.mockReturnValue(['globex']);
    expect((await GET(new NextRequest(`${URL_BASE}?tenant=acme`))).status).toBe(403);
    expect(mocks.resolveCompany).toHaveBeenCalledTimes(1);
    expect(mocks.readCustomerDecisionOverview).toHaveBeenCalledTimes(3);
  });

  it('resolves a company without its own records, or a failed lookup, again on the next request', async () => {
    mocks.resolveCompany.mockImplementation((tenant: string) => company(tenant, false));
    await GET(new NextRequest(`${URL_BASE}?tenant=acme`));
    await GET(new NextRequest(`${URL_BASE}?tenant=acme`));
    expect(mocks.resolveCompany).toHaveBeenCalledTimes(2);
    mocks.resolveCompany.mockImplementationOnce(() => {
      throw new Error('[COMPANY_TENANT_SCOPE] invalid tenant slug');
    });
    expect((await GET(new NextRequest(`${URL_BASE}?tenant=acme`))).status).toBe(500);
    mocks.resolveCompany.mockImplementation((tenant: string) => company(tenant));
    expect((await GET(new NextRequest(`${URL_BASE}?tenant=acme`))).status).toBe(200);
    expect(mocks.resolveCompany).toHaveBeenCalledTimes(4);
    expect(companyIdMemo.size).toBe(1);
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

describe('company id memo', () => {
  const aggregate = (tenant: string, recorded = true) =>
    company(tenant, recorded) as unknown as CompanyAggregate;

  it('expires an entry after its TTL', () => {
    let clock = 0;
    const resolve = vi.fn((tenant: string) => aggregate(tenant));
    const memo = createCompanyIdMemo({ resolve, ttlMs: 1000, now: () => clock });
    expect(memo.companyIdOf('acme')).toBe('org-acme');
    clock = 999;
    expect(memo.companyIdOf('acme')).toBe('org-acme');
    expect(resolve).toHaveBeenCalledTimes(1);
    clock = 1000;
    expect(memo.companyIdOf('acme')).toBe('org-acme');
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('keeps at most its limit, dropping the oldest entry first', () => {
    const resolve = vi.fn((tenant: string) => aggregate(tenant));
    const memo = createCompanyIdMemo({ resolve, limit: 2, now: () => 0 });
    memo.companyIdOf('a');
    memo.companyIdOf('b');
    memo.companyIdOf('c');
    expect(memo.size).toBe(2);
    memo.companyIdOf('b');
    memo.companyIdOf('c');
    expect(resolve).toHaveBeenCalledTimes(3);
    memo.companyIdOf('a');
    expect(resolve).toHaveBeenCalledTimes(4);
  });
});
