import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ listTenantProfileSlugs: vi.fn(() => ['acme', 'globex']) }));

// Only the tenant registry is replaced: every viewer check below is the real one.
vi.mock('@agent/core/organization/tenant-registry', () => ({
  listTenantProfileSlugs: mocks.listTenantProfileSlugs,
}));

import { resolveCustomerDecisionTenant } from './customer-decision-viewer-scope';
import type { ViewerContext } from './viewer-context';

const request = (query = '') =>
  new NextRequest(`http://localhost/api/customer-decisions/case${query}`);

const viewer = (over: Partial<ViewerContext> = {}): ViewerContext => ({
  role: 'readonly',
  tenantSlugs: ['acme'],
  organizationIds: 'all',
  projectIds: 'all',
  tierAccess: ['public', 'confidential'],
  source: 'token',
  ...over,
});

function statusOf(operation: () => unknown): number | undefined {
  try {
    operation();
    return undefined;
  } catch (error) {
    return (error as { status?: number }).status;
  }
}

describe('resolveCustomerDecisionTenant (CD-12)', () => {
  beforeEach(() => {
    mocks.listTenantProfileSlugs.mockReset();
    mocks.listTenantProfileSlugs.mockReturnValue(['acme', 'globex']);
  });

  it('uses the sole tenant of a tenant-scoped viewer', () => {
    expect(resolveCustomerDecisionTenant(request(), viewer())).toEqual({ tenant: 'acme' });
  });

  it('lets the tenant parameter narrow an all-tenant viewer to one tenant', () => {
    const all = viewer({ role: 'localadmin', tenantSlugs: 'all', source: 'loopback' });
    expect(resolveCustomerDecisionTenant(request('?tenant=globex'), all)).toEqual({
      tenant: 'globex',
    });
  });

  it.each([
    ['an all-tenant viewer', 'all' as const],
    ['a multi-tenant viewer', ['acme', 'globex']],
  ])('asks %s without a parameter to pick one (400)', async (_label, tenantSlugs) => {
    const result = resolveCustomerDecisionTenant(request(), viewer({ tenantSlugs }));
    expect(result.tenant).toBeUndefined();
    expect(result.response?.status).toBe(400);
    expect((await result.response?.json()).error).toMatch(/Select one tenant/u);
  });

  it('never widens the viewer to a tenant outside its scope', () => {
    expect(statusOf(() => resolveCustomerDecisionTenant(request('?tenant=globex'), viewer()))).toBe(
      403
    );
  });

  it.each([
    ['a selected project', '?project_id=PRJ-A', viewer()],
    ['a project-limited viewer', '', viewer({ projectIds: ['PRJ-A'] })],
  ])('refuses %s', (_label, query, scoped) => {
    expect(statusOf(() => resolveCustomerDecisionTenant(request(query), scoped))).toBe(403);
  });

  it('refuses an unregistered tenant', () => {
    mocks.listTenantProfileSlugs.mockReturnValue(['globex']);
    expect(statusOf(() => resolveCustomerDecisionTenant(request(), viewer()))).toBe(403);
  });

  it('refuses a viewer without the confidential tier', () => {
    expect(
      statusOf(() => resolveCustomerDecisionTenant(request(), viewer({ tierAccess: ['public'] })))
    ).toBe(403);
  });

  it("checks the tenant's organization (its slug)", () => {
    expect(
      statusOf(() =>
        resolveCustomerDecisionTenant(request(), viewer({ organizationIds: ['other-org'] }))
      )
    ).toBe(403);
    expect(resolveCustomerDecisionTenant(request(), viewer({ organizationIds: ['acme'] }))).toEqual(
      { tenant: 'acme' }
    );
  });

  it('rejects a malformed tenant parameter', () => {
    const all = viewer({ role: 'localadmin', tenantSlugs: 'all', source: 'loopback' });
    expect(statusOf(() => resolveCustomerDecisionTenant(request('?tenant=../acme'), all))).toBe(
      403
    );
  });
});
