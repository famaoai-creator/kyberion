import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { ConciergeViewerContext } from './viewer-context';

const mocks = vi.hoisted(() => ({
  resolveConciergeViewer: vi.fn(),
  listTenantProfileSlugs: vi.fn((): string[] => []),
  registryUnreadable: false,
  warn: vi.fn(),
}));

vi.mock('./viewer-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./viewer-context')>()),
  resolveConciergeViewer: mocks.resolveConciergeViewer,
}));
vi.mock('@agent/core/authority', () => ({
  withExecutionContext: vi.fn((_role: string, fn: () => unknown) => fn()),
}));
vi.mock('@agent/core/logger', () => ({
  createLogger: () => ({ warn: mocks.warn, debug: () => {}, info: () => {}, error: () => {} }),
}));
vi.mock('@agent/core/organization/tenant-registry', () => ({
  listTenantProfileSlugs: () => {
    if (mocks.registryUnreadable) throw new Error('unreadable');
    return mocks.listTenantProfileSlugs();
  },
}));

import { isValidTenantSlug } from '@agent/core/entity-scope';
import { PERSONAL_SELECTION, SYSTEM_SELECTION } from './tenant-context';
import {
  applyTenantSelection,
  conciergeAllowedTenants,
  conversationViewerForSelection,
  readTenantSelectionHints,
  resolveConciergeSelectedViewer,
  resolveSelectedTenantScope,
  scopeMembershipList,
} from './selected-tenant';
import { tenantVisibleToViewer } from './tenant-visibility';
import { ConciergeViewerError, conciergeErrorResponse } from './viewer-context';

function viewer(tenantSlugs: string[] | 'all'): ConciergeViewerContext {
  return {
    role: 'readonly',
    tenantSlugs,
    organizationIds: 'all',
    projectIds: 'all',
    tierAccess: ['confidential', 'public'],
    source: 'token',
    principalId: 'human:tester',
  };
}

function request(query = '', cookie?: string): NextRequest {
  return {
    headers: new Headers(cookie ? { cookie } : {}),
    nextUrl: new URL(`http://concierge.test/api/summary${query}`),
  } as unknown as NextRequest;
}

describe('resolveSelectedTenantScope', () => {
  const allowed = ['acme', 'beta'];
  const explicit = { allCompanies: false };
  const allCompanies = { allCompanies: true };

  it('lets the URL hint beat the cookie hint', () => {
    expect(
      resolveSelectedTenantScope({ url: 'beta', cookie: 'acme' }, allowed, explicit).selection
    ).toEqual({ mode: 'tenant', tenant_slug: 'beta', source: 'url' });
    expect(resolveSelectedTenantScope({ cookie: 'acme' }, allowed, explicit).selection).toEqual({
      mode: 'tenant',
      tenant_slug: 'acme',
      source: 'cookie',
    });
  });

  it('ignores an unauthorized slug and falls back to personal, never to another tenant', () => {
    const fromUrl = resolveSelectedTenantScope({ url: 'evil', cookie: 'acme' }, allowed, explicit);
    expect(fromUrl.selection).toEqual({ mode: 'personal', source: 'default' });
    expect(fromUrl.rejected).toEqual(['url']);
    const fromCookie = resolveSelectedTenantScope({ cookie: 'evil' }, allowed, explicit);
    expect(fromCookie.selection).toEqual({ mode: 'personal', source: 'default' });
    expect(fromCookie.rejected).toEqual(['cookie']);
  });

  it('rejects reserved tier/partition names as tenants, even when listed as allowed', () => {
    for (const reserved of ['public', 'confidential', 'shared']) {
      const result = resolveSelectedTenantScope(
        { url: reserved },
        [...allowed, reserved],
        explicit
      );
      expect(result.selection.mode).toBe('personal');
      expect(result.rejected).toEqual(['url']);
    }
    expect(resolveSelectedTenantScope({}, ['public', 'acme'], explicit).selection).toEqual({
      mode: 'tenant',
      tenant_slug: 'acme',
      source: 'only_tenant',
    });
  });

  it('pins a viewer scoped to one company to it whatever the hints say', () => {
    for (const hints of [
      {},
      { url: 'personal' },
      { url: 'shared' },
      { url: 'evil' },
      { cookie: 'beta' },
    ]) {
      expect(resolveSelectedTenantScope(hints, ['acme'], explicit).selection).toMatchObject({
        mode: 'tenant',
        tenant_slug: 'acme',
      });
    }
  });

  it('selects the personal aggregate explicitly or by default for a multi-tenant viewer', () => {
    expect(
      resolveSelectedTenantScope({ url: 'personal', cookie: 'acme' }, allowed, explicit).selection
    ).toEqual({ mode: 'personal', source: 'url' });
    expect(resolveSelectedTenantScope({ cookie: 'personal' }, allowed, explicit).selection).toEqual(
      { mode: 'personal', source: 'cookie' }
    );
    expect(resolveSelectedTenantScope({}, allowed, explicit).selection).toEqual({
      mode: 'personal',
      source: 'default',
    });
    expect(resolveSelectedTenantScope({ url: 'acme' }, [], explicit).selection.mode).toBe(
      'personal'
    );
  });

  it('uses a system marker that can never be a tenant slug', () => {
    expect(SYSTEM_SELECTION).toBe('shared');
    expect(isValidTenantSlug(SYSTEM_SELECTION)).toBe(false);
    expect(isValidTenantSlug(PERSONAL_SELECTION)).toBe(false);
  });

  it('offers the system view only to an all-company viewer', () => {
    expect(resolveSelectedTenantScope({ url: 'shared' }, allowed, allCompanies)).toEqual({
      selection: { mode: 'system', source: 'url' },
      rejected: [],
    });
    expect(
      resolveSelectedTenantScope({ cookie: 'shared' }, allowed, allCompanies).selection
    ).toEqual({ mode: 'system', source: 'cookie' });
    const refused = resolveSelectedTenantScope(
      { url: 'shared', cookie: 'acme' },
      allowed,
      explicit
    );
    expect(refused.selection).toEqual({ mode: 'personal', source: 'default' });
    expect(refused.rejected).toEqual(['url']);
  });

  it('never pins an all-company viewer to its only registered company', () => {
    expect(resolveSelectedTenantScope({}, ['acme'], allCompanies).selection).toEqual({
      mode: 'personal',
      source: 'default',
    });
    expect(resolveSelectedTenantScope({ url: 'shared' }, ['acme'], allCompanies).selection).toEqual(
      { mode: 'system', source: 'url' }
    );
    expect(resolveSelectedTenantScope({ url: 'acme' }, ['acme'], allCompanies).selection).toEqual({
      mode: 'tenant',
      tenant_slug: 'acme',
      source: 'url',
    });
  });

  it('defaults an all-company viewer with no registered company to the system view', () => {
    expect(resolveSelectedTenantScope({}, [], allCompanies).selection).toEqual({
      mode: 'system',
      source: 'default',
    });
  });
});

describe('applyTenantSelection', () => {
  it('narrows to the selected tenant and refuses one outside the viewer scope', () => {
    expect(
      applyTenantSelection(
        viewer(['acme', 'beta']),
        { mode: 'tenant', tenant_slug: 'beta', source: 'url' },
        ['acme', 'beta']
      ).tenantSlugs
    ).toEqual(['beta']);
    expect(() =>
      applyTenantSelection(
        viewer(['acme']),
        { mode: 'tenant', tenant_slug: 'beta', source: 'url' },
        ['acme', 'beta']
      )
    ).toThrow(/outside the viewer scope/);
    expect(() =>
      applyTenantSelection(viewer('all'), { mode: 'tenant', tenant_slug: 'beta', source: 'url' }, [
        'acme',
      ])
    ).toThrow(/outside the viewer scope/);
  });

  it('hides every company in the personal view, even with no company to aggregate', () => {
    const personal = { mode: 'personal', source: 'default' } as const;
    expect(applyTenantSelection(viewer('all'), personal, ['acme', 'beta']).tenantSlugs).toEqual([]);
    expect(applyTenantSelection(viewer('all'), personal, [])).toMatchObject({ tenantSlugs: [] });
    expect(applyTenantSelection(viewer('all'), personal, []).includeUntenanted).toBeUndefined();
  });

  it('narrows the system view to company-less items, for all-company viewers only', () => {
    const system = { mode: 'system', source: 'url' } as const;
    expect(applyTenantSelection(viewer('all'), system, ['acme'])).toMatchObject({
      tenantSlugs: [],
      includeUntenanted: true,
    });
    expect(() => applyTenantSelection(viewer(['acme', 'beta']), system, ['acme', 'beta'])).toThrow(
      /all-company viewer/
    );
    const carried = { ...viewer('all'), includeUntenanted: true };
    expect(
      applyTenantSelection(carried, { mode: 'tenant', tenant_slug: 'acme', source: 'url' }, [
        'acme',
      ]).includeUntenanted
    ).toBeUndefined();
  });
});

describe('conciergeAllowedTenants', () => {
  beforeEach(() => mocks.listTenantProfileSlugs.mockReset());

  it('uses the explicit scope and drops reserved or malformed names', () => {
    expect(conciergeAllowedTenants(viewer(['beta', 'public', 'Bad Slug', 'acme', 'beta']))).toEqual(
      ['acme', 'beta']
    );
    expect(mocks.listTenantProfileSlugs).not.toHaveBeenCalled();
  });

  it('reads the tenant registry only for an all-tenant viewer', () => {
    mocks.listTenantProfileSlugs.mockImplementation(() => ['shared', 'beta', 'acme']);
    expect(conciergeAllowedTenants(viewer('all'))).toEqual(['acme', 'beta']);
  });

  it('offers no company when the registry is unreadable, and says so at warn level', () => {
    vi.useFakeTimers({ now: new Date('2030-01-01T00:00:00.000Z') });
    mocks.registryUnreadable = true;
    mocks.warn.mockClear();
    try {
      expect(conciergeAllowedTenants(viewer('all'))).toEqual([]);
      expect(mocks.warn).toHaveBeenCalledWith(
        expect.stringMatching(
          /^tenant registry unreadable — .+ \| next: .+ \| evidence: unreadable$/
        )
      );
      expect(conciergeAllowedTenants(viewer('all'))).toEqual([]);
      vi.advanceTimersByTime(59_999);
      expect(conciergeAllowedTenants(viewer('all'))).toEqual([]);
      expect(mocks.warn).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      conciergeAllowedTenants(viewer('all'));
      expect(mocks.warn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      mocks.registryUnreadable = false;
    }
  });

  it('fails closed to no company data, never the unfiltered scope, when the registry is unreadable', () => {
    mocks.resolveConciergeViewer.mockReturnValue({ context: viewer('all') });
    mocks.registryUnreadable = true;
    try {
      for (const hints of [request(), request('?tenant=personal'), request('?tenant=acme')]) {
        const resolved = resolveConciergeSelectedViewer(hints);
        expect(resolved.response).toBeUndefined();
        expect(resolved).toMatchObject({ context: { tenantSlugs: [] } });
      }
    } finally {
      mocks.registryUnreadable = false;
    }
  });
});

describe('resolveConciergeSelectedViewer', () => {
  beforeEach(() => mocks.resolveConciergeViewer.mockReset());

  it('reads the URL hint, then the selection cookie', () => {
    expect(
      readTenantSelectionHints(request('?tenant=acme', 'kyberion_selected_tenant=beta'))
    ).toEqual({
      url: 'acme',
      cookie: 'beta',
    });
    expect(readTenantSelectionHints(request('', 'other=1'))).toEqual({ url: null, cookie: null });
  });

  it('never lets a tampered cookie or URL widen the viewer', () => {
    mocks.resolveConciergeViewer.mockReturnValue({ context: viewer(['acme']) });
    const tamperedCookie = resolveConciergeSelectedViewer(
      request('', 'kyberion_selected_tenant=beta')
    );
    expect(tamperedCookie.response).toBeUndefined();
    expect(tamperedCookie).toMatchObject({ context: { tenantSlugs: ['acme'] } });
    const tamperedUrl = resolveConciergeSelectedViewer(request('?tenant=beta'));
    expect(tamperedUrl).toMatchObject({ context: { tenantSlugs: ['acme'] } });
  });

  it('narrows an all-tenant viewer to the cookie company, or to no company in the personal view', () => {
    mocks.listTenantProfileSlugs.mockImplementation(() => ['acme', 'beta']);
    mocks.resolveConciergeViewer.mockReturnValue({ context: viewer('all') });
    expect(
      resolveConciergeSelectedViewer(request('', 'kyberion_selected_tenant=beta'))
    ).toMatchObject({
      context: { tenantSlugs: ['beta'] },
      viewer: { tenantSlugs: 'all' },
      selection: { mode: 'tenant', tenant_slug: 'beta' },
    });
    expect(resolveConciergeSelectedViewer(request())).toMatchObject({
      context: { tenantSlugs: [] },
      selection: { mode: 'personal' },
    });
  });

  it('shapes a selection outside the viewer scope as a 403, never an unshaped error', () => {
    for (const attempt of [
      () => applyTenantSelection(viewer(['acme']), { mode: 'system', source: 'url' }, ['acme']),
      () =>
        applyTenantSelection(
          viewer(['acme']),
          { mode: 'tenant', tenant_slug: 'beta', source: 'url' },
          ['acme', 'beta']
        ),
    ]) {
      let thrown: unknown;
      try {
        attempt();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ConciergeViewerError);
      expect(conciergeErrorResponse(thrown).status).toBe(403);
    }
  });

  it('passes an unauthenticated response through untouched', () => {
    const response = new Response(null, { status: 401 });
    mocks.resolveConciergeViewer.mockReturnValue({ response });
    expect(resolveConciergeSelectedViewer(request()).response).toBe(response);
  });

  it('resolves the system view for an all-company viewer and refuses it for an explicit one', () => {
    mocks.listTenantProfileSlugs.mockImplementation(() => ['acme']);
    mocks.resolveConciergeViewer.mockReturnValue({ context: viewer('all') });
    expect(resolveConciergeSelectedViewer(request('?tenant=shared'))).toMatchObject({
      context: { tenantSlugs: [], includeUntenanted: true },
      selection: { mode: 'system' },
    });
    mocks.resolveConciergeViewer.mockReturnValue({ context: viewer(['acme', 'beta']) });
    const refused = resolveConciergeSelectedViewer(request('?tenant=shared'));
    expect(refused).toMatchObject({
      context: { tenantSlugs: [] },
      selection: { mode: 'personal' },
    });
    expect(refused.response === undefined && refused.context.includeUntenanted).toBeFalsy();
  });

  it('keeps the personal conversation in the viewer scope but narrows a company conversation', () => {
    mocks.listTenantProfileSlugs.mockImplementation(() => ['acme', 'beta']);
    mocks.resolveConciergeViewer.mockReturnValue({ context: viewer('all') });
    expect(conversationViewerForSelection(request()).context?.tenantSlugs).toBe('all');
    expect(conversationViewerForSelection(request('?tenant=shared')).context?.tenantSlugs).toBe(
      'all'
    );
    expect(conversationViewerForSelection(request('?tenant=acme')).context?.tenantSlugs).toEqual([
      'acme',
    ]);
  });
});

describe('scopeMembershipList', () => {
  const members = [
    { id: 'a', memberships: [{ tenant_slug: 'acme' }, { tenant_slug: 'beta' }] },
    { id: 'b', memberships: [{ tenant_slug: 'beta' }] },
  ];
  const unassigned = { id: 'c', memberships: [] };

  it('keeps only the selected company and cuts memberships to it', () => {
    expect(scopeMembershipList(members, { tenantSlugs: ['acme'] })).toEqual([
      { id: 'a', memberships: [{ tenant_slug: 'acme' }] },
    ]);
    expect(scopeMembershipList([...members, unassigned], { tenantSlugs: [] })).toEqual([]);
    expect(scopeMembershipList(members, { tenantSlugs: 'all' })).toEqual(members);
  });

  it('lists only members with no company in the system view', () => {
    expect(
      scopeMembershipList([...members, unassigned], { tenantSlugs: [], includeUntenanted: true })
    ).toEqual([unassigned]);
  });
});

describe('tenantVisibleToViewer', () => {
  it('admits company-less records only in the system view', () => {
    expect(tenantVisibleToViewer({ tenantSlugs: ['acme'] }, 'acme')).toBe(true);
    expect(tenantVisibleToViewer({ tenantSlugs: ['acme'] }, 'beta')).toBe(false);
    expect(tenantVisibleToViewer({ tenantSlugs: ['acme'] }, undefined)).toBe(false);
    expect(tenantVisibleToViewer({ tenantSlugs: [] }, undefined)).toBe(false);
    expect(tenantVisibleToViewer({ tenantSlugs: [], includeUntenanted: true }, undefined)).toBe(
      true
    );
    expect(tenantVisibleToViewer({ tenantSlugs: [], includeUntenanted: true }, 'acme')).toBe(false);
    expect(tenantVisibleToViewer({ tenantSlugs: 'all' }, undefined)).toBe(true);
  });
});
