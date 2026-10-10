import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { CeoSurfaceSummary } from '@agent/core/ceo-surface-summary';
import type { OperatorHomeScopeFilter } from '@agent/core/surface/operator-home-summary';
import type { ConciergeViewerContext } from '../../lib/viewer-context';

/**
 * Route-level proof that the rail's company selection is server-validated:
 * a tampered cookie or URL can never make a read route return another
 * tenant's data, the personal view only returns per-company counts, and the
 * system view (all-company viewers only) returns only company-less items.
 */
const state = vi.hoisted(() => ({
  viewer: null as ConciergeViewerContext | null,
  registry: ['acme', 'beta'] as string[],
  profiles: null as string[] | null,
}));

const APPROVALS: Array<{ id: string; tenant_slug?: string; title: string }> = [
  { id: 'a-1', tenant_slug: 'acme', title: 'Acme invoice' },
  { id: 'a-2', tenant_slug: 'acme', title: 'Acme contract' },
  { id: 'b-1', tenant_slug: 'beta', title: 'Beta secret plan' },
  { id: 's-1', title: 'System runtime upgrade' },
];

const MISSION_TENANTS: Record<string, string> = {
  'MSN-ACME': 'acme',
  'MSN-BETA': 'beta',
  'MSN-SYSTEM': 'shared',
};

vi.mock('../../lib/viewer-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/viewer-context')>()),
  resolveConciergeViewer: () => ({ context: state.viewer }),
}));
vi.mock('@agent/core/authority', () => ({
  withExecutionContext: (_role: string, fn: () => unknown) => fn(),
}));
vi.mock('@agent/core/organization/tenant-registry', () => ({
  listTenantProfileSlugs: () => state.registry,
  readTenantProfile: (slug: string) => ({ tenant_slug: slug, display_name: `${slug} Inc.` }),
}));
vi.mock('@agent/core/front-desk-identity', () => ({
  readFrontDeskMe: (scope: ConciergeViewerContext, input: { requestedTenant: string | null }) => {
    const tenants = (state.profiles ?? state.registry)
      .filter((slug) => scope.tenantSlugs === 'all' || scope.tenantSlugs.includes(slug))
      .map((slug) => ({
        tenant_slug: slug,
        display_name: `${slug} Inc.`,
        role: 'viewer',
        status: 'active',
      }));
    return {
      ok: true,
      viewing: tenants.find((tenant) => tenant.tenant_slug === input.requestedTenant) ?? null,
      tenants,
      can_switch: tenants.length > 1,
    };
  },
}));
vi.mock('@agent/core/organization/member-registry', () => ({ ensureOwnerMember: () => {} }));
vi.mock('@agent/core/browser/browser-onboarding', () => ({
  getBrowserOnboardingState: () => ({ onboarding: { status: 'complete' } }),
}));
vi.mock('../../lib/headless-projections', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/headless-projections')>()),
  conciergeAvailableOperations: () => [],
}));
vi.mock('@agent/core/delegated-task-observability', () => ({
  listActiveDelegatedTaskRecords: () =>
    ['MSN-ACME', 'MSN-BETA', 'MSN-SYSTEM', undefined].map((missionId, index) => ({
      delegation_id: `d-${index}`,
      ...(missionId ? { mission_id: missionId } : {}),
      task_id: `t-${index}`,
      backend_name: 'stub',
      created_at: '2026-10-10T00:00:00.000Z',
    })),
}));
vi.mock('@agent/core/mission/delegation-concurrency', () => ({
  getDelegationConcurrencyStats: () => ({ global: { queued: 3 } }),
  peekPersistedDelegationChildrenRegistry: () => [],
}));
vi.mock('@agent/core/owner-scope', () => ({
  SHARED_TENANT: 'shared',
  tryResolveOwnerScope: ({ id }: { id: string }) =>
    MISSION_TENANTS[id] ? { tenant: MISSION_TENANTS[id], tier: 'confidential' } : null,
}));
vi.mock('@agent/core/ceo-surface-summary', () => ({
  buildCeoSurfaceSummary: ({ scope }: { scope: OperatorHomeScopeFilter }): CeoSurfaceSummary => {
    const approvals = APPROVALS.filter((item) =>
      item.tenant_slug
        ? scope.tenantSlugs === 'all' || scope.tenantSlugs?.includes(item.tenant_slug)
        : scope.tenantSlugs === 'all' || scope.includeUntenanted === true
    ).map((item) => ({
      ...item,
      channel: 'chronos',
      storage_channel: 'chronos',
      reason: '',
      requested_at: '2026-10-10T00:00:00.000Z',
    }));
    return {
      generated_at: '2026-10-10T00:00:00.000Z',
      briefing: {
        sentence_ja: '',
        counts: {
          active_missions: 0,
          pending_approvals: approvals.length,
          unread_outcomes: 0,
          exceptions: 0,
        },
      },
      intent_inbox: [],
      approval_queue: approvals,
      outcome_feed: [],
      exception_feed: [],
    };
  },
}));
vi.mock('@agent/core/knowledge/memory-promotion-queue', () => ({
  listMemoryPromotionCandidates: () => [
    {
      candidate_id: 'm-acme',
      status: 'queued',
      sensitivity_tier: 'confidential',
      scope: { tenant_slug: 'acme' },
      summary: 'acme memory',
      queued_at: '2026-10-10T00:00:00.000Z',
    },
    {
      candidate_id: 'm-beta',
      status: 'queued',
      sensitivity_tier: 'confidential',
      scope: { tenant_slug: 'beta' },
      summary: 'beta memory',
      queued_at: '2026-10-10T00:00:00.000Z',
    },
  ],
}));

import { GET as summaryGET } from './summary/route';
import { GET as memoryQueueGET } from './memory-queue/route';
import { GET as personalGET } from './personal-summary/route';
import { GET as meGET } from './me/route';
import { GET as responseStatusGET } from './response-status/route';
import { railSwitcherOptions } from '../../lib/rail-switcher';

function viewer(
  tenantSlugs: string[] | 'all',
  principalId = 'human:tester'
): ConciergeViewerContext {
  return {
    role: 'readonly',
    tenantSlugs,
    organizationIds: 'all',
    projectIds: 'all',
    tierAccess: ['confidential', 'public'],
    source: 'token',
    principalId,
  };
}

function request(path: string, cookie?: string): NextRequest {
  return {
    method: 'GET',
    headers: new Headers(cookie ? { cookie } : {}),
    nextUrl: new URL(`http://concierge.test${path}`),
  } as unknown as NextRequest;
}

const tenantsIn = (body: { summary?: CeoSurfaceSummary }) =>
  [...new Set((body.summary?.approval_queue ?? []).map((item) => item.tenant_slug))].sort();
const approvalIds = (body: { summary?: CeoSurfaceSummary }) =>
  (body.summary?.approval_queue ?? []).map((item) => item.id).sort();

describe('company selection on Concierge read routes', () => {
  beforeEach(() => {
    state.viewer = viewer(['acme', 'beta']);
    state.registry = ['acme', 'beta'];
    state.profiles = null;
  });

  it('returns only the selected company, with the URL beating the cookie', async () => {
    const byCookie = await summaryGET(request('/api/summary', 'kyberion_selected_tenant=beta'));
    expect(tenantsIn(await byCookie.json())).toEqual(['beta']);
    const byUrl = await summaryGET(
      request('/api/summary?tenant=acme', 'kyberion_selected_tenant=beta')
    );
    expect(tenantsIn(await byUrl.json())).toEqual(['acme']);
  });

  it('a tampered cookie cannot read a tenant outside the viewer scope', async () => {
    state.viewer = viewer(['acme']);
    const res = await summaryGET(request('/api/summary', 'kyberion_selected_tenant=beta'));
    expect(res.status).toBe(200);
    expect(tenantsIn(await res.json())).toEqual(['acme']);
    const memory = await memoryQueueGET(
      request('/api/memory-queue', 'kyberion_selected_tenant=beta')
    );
    const ids = ((await memory.json()) as { candidates: Array<{ id: string }> }).candidates.map(
      (item) => item.id
    );
    expect(ids).toEqual(['m-acme']);
  });

  it('a tampered URL selection is refused and never returns the other tenant', async () => {
    state.viewer = viewer(['acme']);
    const res = await summaryGET(request('/api/summary?tenant=beta'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(tenantsIn(body)).toEqual(['acme']);
    expect(JSON.stringify(body)).not.toContain('Beta secret plan');
  });

  it('an all-tenant viewer cannot select a tenant missing from the registry', async () => {
    state.viewer = viewer('all');
    state.registry = ['acme'];
    const res = await summaryGET(request('/api/summary', 'kyberion_selected_tenant=beta'));
    expect(approvalIds(await res.json())).toEqual([]);
  });

  it('shows an all-company viewer only the company-less items in the system view', async () => {
    state.viewer = viewer('all');
    const res = await summaryGET(request('/api/summary?tenant=shared'));
    expect(res.status).toBe(200);
    expect(approvalIds(await res.json())).toEqual(['s-1']);
  });

  it('lets an all-company viewer with one registered company still reach the system view', async () => {
    state.viewer = viewer('all');
    state.registry = ['acme'];
    const system = await summaryGET(request('/api/summary', 'kyberion_selected_tenant=shared'));
    expect(approvalIds(await system.json())).toEqual(['s-1']);
    const byDefault = await summaryGET(request('/api/summary'));
    expect(approvalIds(await byDefault.json())).toEqual([]);
  });

  it('never gives an explicitly scoped viewer the system view', async () => {
    for (const scope of [['acme', 'beta'], ['acme']]) {
      state.viewer = viewer(scope);
      const res = await summaryGET(request('/api/summary?tenant=shared'));
      expect(res.status).toBe(200);
      expect(approvalIds(await res.json())).not.toContain('s-1');
    }
  });

  it('the personal view hides every company item from the data routes', async () => {
    const res = await summaryGET(request('/api/summary', 'kyberion_selected_tenant=personal'));
    expect(tenantsIn(await res.json())).toEqual([]);
    const memory = await memoryQueueGET(request('/api/memory-queue'));
    expect(((await memory.json()) as { candidates: unknown[] }).candidates).toEqual([]);
  });
});

describe('/api/personal-summary', () => {
  beforeEach(() => {
    state.viewer = viewer(['acme', 'beta']);
    state.registry = ['acme', 'beta'];
    state.profiles = null;
  });

  it('returns one count card per allowed company and no item lists', async () => {
    const res = await personalGET(request('/api/personal-summary'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      companies: Array<{
        tenant_slug: string;
        display_name: string;
        counts: { pending_approvals: number };
      }>;
    };
    expect(
      body.companies.map((card) => [
        card.tenant_slug,
        card.display_name,
        card.counts.pending_approvals,
      ])
    ).toEqual([
      ['acme', 'acme Inc.', 2],
      ['beta', 'beta Inc.', 1],
    ]);
    expect(JSON.stringify(body)).not.toContain('approval_queue');
  });

  it('is refused while a company is selected, so a company view never fetches the others', async () => {
    const res = await personalGET(
      request('/api/personal-summary', 'kyberion_selected_tenant=acme')
    );
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).not.toContain('beta');
  });

  it('never summarizes a company outside the viewer scope', async () => {
    state.viewer = viewer(['acme', 'gamma']);
    const res = await personalGET(request('/api/personal-summary'));
    const body = (await res.json()) as { companies: Array<{ tenant_slug: string }> };
    expect(body.companies.map((card) => card.tenant_slug)).toEqual(['acme', 'gamma']);
    expect(JSON.stringify(body)).not.toContain('Beta');
  });

  it('adds a system card with the company-less counts for an all-company viewer only', async () => {
    state.viewer = viewer('all');
    const res = await personalGET(request('/api/personal-summary'));
    const body = (await res.json()) as {
      companies: Array<{ tenant_slug: string }>;
      system?: { counts: { pending_approvals: number }; headline?: string };
    };
    expect(body.companies.map((card) => card.tenant_slug)).toEqual(['acme', 'beta']);
    expect(body.system).toEqual({
      counts: { active_missions: 0, pending_approvals: 1, unread_outcomes: 0, exceptions: 0 },
      headline: 'System runtime upgrade',
    });
    state.viewer = viewer(['acme', 'beta']);
    const explicit = (await (await personalGET(request('/api/personal-summary'))).json()) as {
      system?: unknown;
    };
    expect(explicit.system).toBeUndefined();
  });

  it('has its own rate-limit bucket', async () => {
    state.viewer = viewer(['acme', 'beta'], 'human:rate-limited');
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect((await personalGET(request('/api/personal-summary'))).status).toBe(200);
    }
    const limited = await personalGET(request('/api/personal-summary'));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toMatch(/^\d+$/);
    state.viewer = viewer(['acme', 'beta'], 'human:someone-else');
    expect((await personalGET(request('/api/personal-summary'))).status).toBe(200);
  });
});

interface MeBody {
  viewing: { tenant_slug: string } | null;
  selection: { mode: string; tenant_slug?: string };
  switcher: {
    personal: boolean;
    system: boolean;
    companies: Array<{ tenant_slug: string; display_name: string }>;
  };
}

describe('/api/me switcher', () => {
  beforeEach(() => {
    state.registry = ['acme', 'ghost'];
    state.profiles = ['acme'];
  });

  it('keeps the switcher usable when the selected company has no profile', async () => {
    state.viewer = viewer('all');
    const body = (await (await meGET(request('/api/me?tenant=ghost'))).json()) as MeBody;
    expect(body.viewing).toBeNull();
    expect(body.selection).toEqual({ mode: 'tenant', tenant_slug: 'ghost' });
    expect(body.switcher).toEqual({
      personal: true,
      system: true,
      companies: [
        { tenant_slug: 'acme', display_name: 'acme Inc.' },
        { tenant_slug: 'ghost', display_name: 'ghost' },
      ],
    });
    const options = railSwitcherOptions({ mode: 'tenant', tenant_slug: 'ghost' }, body.switcher, {
      personal: 'Personal',
      system: 'System',
    });
    expect(options.map((option) => [option.value, option.selected])).toEqual([
      ['personal', false],
      ['acme', false],
      ['ghost', true],
      ['shared', false],
    ]);
  });

  it('offers personal, every company and system to an all-company viewer with one company', async () => {
    state.viewer = viewer('all');
    state.registry = ['acme'];
    const body = (await (await meGET(request('/api/me'))).json()) as MeBody;
    expect(body.selection).toEqual({ mode: 'personal', aggregate: true });
    expect(body.switcher).toMatchObject({ personal: true, system: true });
    const system = (await (await meGET(request('/api/me?tenant=shared'))).json()) as MeBody;
    expect(system.selection).toEqual({ mode: 'system' });
  });

  it('offers no system view to an explicitly scoped viewer', async () => {
    state.viewer = viewer(['acme', 'ghost']);
    const body = (await (await meGET(request('/api/me?tenant=shared'))).json()) as MeBody;
    expect(body.selection.mode).toBe('personal');
    expect(body.switcher).toMatchObject({ personal: true, system: false });
  });
});

interface ResponseStatusBody {
  response_status: {
    active_count: number;
    queued_count: number;
    active_tasks: Array<{ mission_id?: string }>;
  };
}

describe('/api/response-status', () => {
  beforeEach(() => {
    state.registry = ['acme', 'beta'];
  });

  const missions = async (path: string, cookie?: string) => {
    const body = (await (
      await responseStatusGET(request(path, cookie))
    ).json()) as ResponseStatusBody;
    return body.response_status.active_tasks.map((task) => task.mission_id ?? '(none)');
  };

  it("lists only the selected company's delegated tasks, with no host-wide counts", async () => {
    state.viewer = viewer(['acme']);
    expect(await missions('/api/response-status')).toEqual(['MSN-ACME']);
    const body = (await (
      await responseStatusGET(request('/api/response-status'))
    ).json()) as ResponseStatusBody;
    expect(body.response_status.queued_count).toBe(0);
    state.viewer = viewer(['acme', 'beta']);
    expect(await missions('/api/response-status', 'kyberion_selected_tenant=beta')).toEqual([
      'MSN-BETA',
    ]);
    expect(await missions('/api/response-status')).toEqual([]);
  });

  it('lists only company-less tasks in the system view', async () => {
    state.viewer = viewer('all');
    expect(await missions('/api/response-status?tenant=shared')).toEqual(['MSN-SYSTEM', '(none)']);
  });
});
