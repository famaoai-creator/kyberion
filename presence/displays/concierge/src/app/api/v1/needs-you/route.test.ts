import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({
  resolveViewer: vi.fn(),
  readHome: vi.fn(),
  hygiene: vi.fn(),
  memory: vi.fn(),
  failures: vi.fn(),
}));

vi.mock('../../../../lib/viewer-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../lib/viewer-context')>()),
  resolveConciergeViewer: mocks.resolveViewer,
}));
vi.mock('../../../../lib/headless-projections', () => ({ readConciergeHome: mocks.readHome }));
vi.mock('../../../../lib/hygiene-server', () => ({ listHygieneInquiries: mocks.hygiene }));
vi.mock('@agent/core/organization/tenant-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/organization/tenant-registry')>()),
  listTenantProfileSlugs: () => ['acme', 'famao-ai'],
}));
vi.mock('@agent/core/surface/needs-you-sources', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/surface/needs-you-sources')>()),
  readNeedsYouFailures: mocks.failures,
}));
vi.mock('@agent/core/knowledge/memory-promotion-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/knowledge/memory-promotion-queue')>()),
  listMemoryPromotionCandidates: mocks.memory,
}));

import { GET as LIST } from './route.js';
import { GET as SUMMARY } from './summary/route.js';
import { GET as CATCH_ALL } from '../[...operation]/route.js';

function viewer(tenantSlugs: string[] | 'all') {
  return {
    role: 'localadmin',
    tenantSlugs,
    organizationIds: 'all',
    projectIds: 'all',
    tierAccess: ['confidential', 'public'],
    source: 'token',
    principalId: 'human:test',
  };
}

function approval(id: string, tenant: string, groupKey = id) {
  return {
    id,
    channel: 'external-operation',
    storage_channel: 'external-operation',
    title: `Approval ${id}`,
    reason: '',
    requested_at: '2026-11-05T10:00:00.000Z',
    tenant_slug: tenant,
    organization_id: tenant,
    brief: {
      ask: { text: `Ask ${id}` },
      why: [],
      onApprove: { text: 'a' },
      onReject: { text: 'r' },
      ifSilent: { text: 's' },
      requester: { key: 'ux_a_actor_agent', params: { name: 'Planner' } },
      state: 'pending',
      groupKey,
      details: [],
    },
  };
}

function request(query = ''): NextRequest {
  return new NextRequest(`http://127.0.0.1:3272/api/v1/needs-you${query}`);
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.hygiene.mockReturnValue([]);
  mocks.memory.mockReturnValue([]);
  mocks.failures.mockReturnValue([]);
  // A reader that returns too much: the builder must still drop what the viewer cannot see.
  mocks.readHome.mockReturnValue({
    approval_queue: [
      approval('f1', 'famao-ai', 'same'),
      approval('f2', 'famao-ai', 'same'),
      approval('a1', 'acme'),
    ],
    outcome_feed: [],
    exception_feed: [],
  });
});

describe('GET /api/v1/needs-you/summary', () => {
  it('counts within the server-resolved viewer scope, folded groups once', async () => {
    mocks.resolveViewer.mockReturnValue({ context: viewer(['famao-ai']) });
    const response = await SUMMARY(request('/summary'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      ok: true,
      total: 1,
      overdue: 0,
      oldestWaitingSince: '2026-11-05T10:00:00.000Z',
      byReason: { approval: 1, decision: 0, review: 0, knowledge: 0, clarification: 0, failure: 0 },
    });
    expect(mocks.readHome.mock.calls[0]![0].tenantSlugs).toEqual(['famao-ai']);
  });

  it('a client tenant narrows the viewer', async () => {
    mocks.resolveViewer.mockReturnValue({ context: viewer(['famao-ai', 'acme']) });
    const body = await (await SUMMARY(request('/summary?tenant=acme'))).json();
    expect(body.total).toBe(1);
    expect(mocks.readHome.mock.calls[0]![0].tenantSlugs).toEqual(['acme']);
  });

  it('a client tenant outside the viewer never widens it', async () => {
    mocks.resolveViewer.mockReturnValue({ context: viewer(['famao-ai']) });
    const response = await SUMMARY(request('/summary?organization_id=acme-org&tenant=famao-ai'));
    // An org inside an all-org viewer narrows: no item names it, so nothing is left.
    expect((await response.json()).total).toBe(0);
    mocks.resolveViewer.mockReturnValue({
      context: { ...viewer(['famao-ai']), organizationIds: ['famao-ai'] },
    });
    const denied = await SUMMARY(request('/summary?organization_id=acme'));
    expect(denied.status).toBe(403);
    expect(mocks.readHome).toHaveBeenCalledTimes(1);
  });

  it('passes an unauthenticated request through as 401 without reading anything', async () => {
    mocks.resolveViewer.mockReturnValue({
      response: NextResponse.json({ ok: false }, { status: 401 }),
    });
    const response = await SUMMARY(request('/summary'));
    expect(response.status).toBe(401);
    expect(mocks.readHome).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/needs-you', () => {
  it('returns the contract shape with the folded group and its true count', async () => {
    mocks.resolveViewer.mockReturnValue({ context: viewer('all') });
    const body = await (await LIST(request('?reason=approval&limit=1'))).json();
    expect(body.ok).toBe(true);
    expect(body.total).toBe(2);
    expect(body.items).toHaveLength(1);
    expect(body.nextCursor).toBe('1');
    const all = await (await LIST(request('?reason=approval'))).json();
    const folded = all.items.find((item: { group_size: number }) => item.group_size > 1);
    expect(folded.group_size).toBe(2);
    expect(folded.group).toHaveLength(1);
  });

  it('the personal view aggregates each allowed company through a narrowed viewer', async () => {
    mocks.resolveViewer.mockReturnValue({ context: viewer('all') });
    const body = await (await SUMMARY(request('/summary'))).json();
    // Four views read the same records; each record still counts once.
    expect(body.total).toBe(2);
    expect(mocks.readHome.mock.calls.map(([view]) => view.tenantSlugs)).toEqual([
      [],
      ['acme'],
      ['famao-ai'],
      [],
    ]);
    expect(mocks.readHome.mock.calls[3]![0].includeUntenanted).toBe(true);
  });

  it('rejects an unknown filter value', async () => {
    mocks.resolveViewer.mockReturnValue({ context: viewer('all') });
    const response = await LIST(request('?reason=everything'));
    expect(response.status).toBe(400);
  });

  it('ignores query keys the operation does not declare (review L3)', async () => {
    mocks.resolveViewer.mockReturnValue({ context: viewer('all') });
    const response = await LIST(request('?reason=approval&_=1730800000'));
    expect(response.status).toBe(200);
  });

  it('a selected company keeps only items tagged with it, as MCP does (review M4)', async () => {
    mocks.resolveViewer.mockReturnValue({ context: viewer(['famao-ai', 'acme']) });
    mocks.failures.mockReturnValue([
      {
        id: 'f-untagged',
        title: 'Broke',
        text: '',
        surface: 'presence',
        created_at: '2026-11-05T10:00:00.000Z',
      },
      {
        id: 'f-acme',
        title: 'Broke',
        text: '',
        surface: 'presence',
        created_at: '2026-11-05T10:00:00.000Z',
        tenant_slug: 'acme',
      },
    ]);
    const body = await (await LIST(request('?tenant=acme&reason=failure'))).json();
    expect(body.items.map((item: { id: string }) => item.id)).toEqual(['failure:f-acme']);
  });

  it('the v1 catch-all answers needs-you with the same count (review L1)', async () => {
    mocks.resolveViewer.mockReturnValue({ context: viewer(['famao-ai']) });
    const direct = await (await SUMMARY(request('/summary'))).json();
    const viaCatchAll = await (
      await CATCH_ALL(request('/summary'), {
        params: Promise.resolve({ operation: ['needs-you', 'summary'] }),
      })
    ).json();
    expect(viaCatchAll).toEqual(direct);
  });
});
