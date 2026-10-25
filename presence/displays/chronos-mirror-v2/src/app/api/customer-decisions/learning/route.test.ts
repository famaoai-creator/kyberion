import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  readCustomerDecisionFacade: vi.fn(),
  listTenantProfileSlugs: vi.fn(() => ['acme', 'globex']),
  guardRequest: vi.fn(() => null),
  requireChronosAccess: vi.fn(() => null),
  resolveViewerContextForRequest: vi.fn(),
  strictViewerScopeTenantSlugs: vi.fn(),
  strictViewerScopeProjectIds: vi.fn(),
  strictViewerScopeOrganizationIds: vi.fn(),
  strictViewerTier: vi.fn(),
  resolveCompany: vi.fn(),
  withViewerExecutionContext: vi.fn((_viewer: unknown, operation: () => unknown) => operation()),
  viewerErrorResponse: vi.fn(
    (error: Error, status?: number) => new Response(error.message, { status: status ?? 403 })
  ),
}));

vi.mock('../../../../lib/customer-decision-overview-facade', () => ({
  readCustomerDecisionFacade: mocks.readCustomerDecisionFacade,
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
import { ViewerContextError } from '../../../../lib/viewer-context';

const URL_BASE = 'http://localhost/api/customer-decisions/learning';
const DETAIL = { version: '1.0.0', tenant_slug: 'acme', report_date: '2026-10-19' };
const ALL_VIEWER = { role: 'localadmin', tenantSlugs: 'all', source: 'loopback' };
const get = (query: string) => GET(new NextRequest(`${URL_BASE}${query}`));

describe('customer-decisions learning route (CD-12 drill-down)', () => {
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
    mocks.readCustomerDecisionFacade.mockResolvedValue({ ok: true, value: DETAIL });
    mocks.strictViewerTier.mockReturnValue('confidential');
    mocks.strictViewerScopeOrganizationIds.mockReturnValue('all');
  });

  it('reads the latest report of the tenant the parameter narrows the viewer to (no-store)', async () => {
    const response = await get('?tenant=acme');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(mocks.requireChronosAccess).toHaveBeenCalledWith(expect.anything(), 'readonly');
    expect(mocks.strictViewerScopeTenantSlugs).toHaveBeenCalledWith(ALL_VIEWER, 'acme');
    expect(mocks.readCustomerDecisionFacade).toHaveBeenCalledWith('learning', 'acme', undefined);
    expect(await response.json()).toEqual({ learning: DETAIL });
  });

  it('checks the confidential tier and the tenant organization before reading', async () => {
    await get('?tenant=acme');
    expect(mocks.strictViewerTier).toHaveBeenCalledWith(ALL_VIEWER, 'confidential');
    expect(mocks.strictViewerScopeOrganizationIds).toHaveBeenCalledWith(ALL_VIEWER, 'acme');
    const order = (mock: { mock: { invocationCallOrder: number[] } }) =>
      mock.mock.invocationCallOrder[0];
    expect(order(mocks.strictViewerTier)).toBeLessThan(order(mocks.readCustomerDecisionFacade));
    expect(order(mocks.strictViewerScopeOrganizationIds)).toBeLessThan(
      order(mocks.readCustomerDecisionFacade)
    );
  });

  it.each([
    ['tier', 'strictViewerTier'],
    ['organization', 'strictViewerScopeOrganizationIds'],
    ['tenant', 'strictViewerScopeTenantSlugs'],
  ] as const)('refuses a viewer outside the %s scope (no child)', async (_label, check) => {
    mocks[check].mockImplementation(() => {
      throw new ViewerContextError(403, `viewer ${check} denied`);
    });
    const response = await get('?tenant=acme');
    expect(response.status).toBe(403);
    expect(mocks.readCustomerDecisionFacade).not.toHaveBeenCalled();
  });

  it.each(['selected', 'grant'])('refuses %s project scope', async (mode) => {
    if (mode === 'grant') mocks.strictViewerScopeProjectIds.mockReturnValue(['PRJ-A']);
    const suffix = mode === 'selected' ? '&project_id=PRJ-A' : '';
    const response = await get(`?tenant=acme${suffix}`);
    expect(response.status).toBe(403);
    expect(mocks.readCustomerDecisionFacade).not.toHaveBeenCalled();
  });

  it('asks a multi-tenant viewer to pick one tenant (400)', async () => {
    mocks.strictViewerScopeTenantSlugs.mockReturnValue(['acme', 'globex']);
    const response = await get('');
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/Select one tenant/u);
    expect(mocks.readCustomerDecisionFacade).not.toHaveBeenCalled();
  });

  it('refuses an unregistered tenant', async () => {
    const response = await get('?tenant=ghost');
    expect(response.status).toBe(403);
    expect(mocks.readCustomerDecisionFacade).not.toHaveBeenCalled();
  });

  it('reads the report of the requested date', async () => {
    const response = await get('?tenant=acme&date=2026-10-19');
    expect(response.status).toBe(200);
    expect(mocks.readCustomerDecisionFacade).toHaveBeenCalledWith('learning', 'acme', '2026-10-19');
  });

  it('uses the sole tenant of a tenant-scoped viewer without a parameter', async () => {
    mocks.strictViewerScopeTenantSlugs.mockReturnValue(['globex']);
    const response = await get('');
    expect(response.status).toBe(200);
    expect(mocks.readCustomerDecisionFacade).toHaveBeenCalledWith('learning', 'globex', undefined);
  });

  it.each([
    '?tenant=acme&date=2026-1-19',
    '?tenant=acme&date=latest',
    '?tenant=acme&date=../2026-10-19',
    '?tenant=acme&date=2026-10-19T00:00',
  ])('rejects an invalid date %s with 400 and spawns nothing', async (query) => {
    const response = await get(query);
    expect(response.status).toBe(400);
    expect(mocks.readCustomerDecisionFacade).not.toHaveBeenCalled();
  });

  it.each([404, 502, 503, 504])(
    'passes a mapped facade %i through without detail',
    async (status) => {
      mocks.readCustomerDecisionFacade.mockResolvedValue({ ok: false, status, error: 'fixed' });
      const response = await get('?tenant=acme');
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: 'fixed' });
    }
  );

  it('returns the viewer resolution response as is', async () => {
    mocks.resolveViewerContextForRequest.mockReturnValue({
      response: new Response('unknown token', { status: 401 }),
    });
    const response = await get('?tenant=acme');
    expect(response.status).toBe(401);
    expect(mocks.readCustomerDecisionFacade).not.toHaveBeenCalled();
  });

  it('does not run when read-only access is denied', async () => {
    mocks.requireChronosAccess.mockReturnValue(new Response('forbidden', { status: 403 }));
    const response = await get('?tenant=acme');
    expect(response.status).toBe(403);
    expect(mocks.resolveViewerContextForRequest).not.toHaveBeenCalled();
  });
});
