import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  approvals: vi.fn(),
  inbox: vi.fn(),
  notifications: vi.fn(),
  memory: vi.fn(),
  hygiene: vi.fn(),
}));

vi.mock('../governance/approval-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../governance/approval-store.js')>()),
  listApprovalRequests: mocks.approvals,
}));
vi.mock('../deliverable-inbox.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../deliverable-inbox.js')>()),
  listInboxEntries: mocks.inbox,
}));
vi.mock('./surface-ux.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./surface-ux.js')>()),
  listSurfaceNotificationsAcrossChannels: mocks.notifications,
}));
vi.mock('../knowledge/memory-promotion-queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../knowledge/memory-promotion-queue.js')>()),
  listMemoryPromotionCandidates: mocks.memory,
}));
vi.mock('../mission/mission-hygiene.js', () => ({ collectMissionHygieneReport: mocks.hygiene }));

import { readNeedsYouSources } from './needs-you-sources.js';

function record(id: string, scope: Record<string, string> | undefined) {
  return {
    id,
    kind: 'mission_gate',
    channel: 'external-operation',
    storageChannel: 'external-operation',
    title: `Approval required: ${id}`,
    summary: '',
    status: 'pending',
    requestedBy: 'agent:planner',
    requestedAt: '2026-11-05T10:00:00.000Z',
    ...(scope ? { scope } : {}),
  };
}

const viewer = {
  role: 'readonly' as const,
  tenantSlugs: ['famao-ai'],
  organizationIds: 'all' as const,
  projectIds: 'all' as const,
  tierAccess: ['confidential', 'public'],
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.inbox.mockReturnValue([]);
  mocks.notifications.mockReturnValue([]);
  mocks.memory.mockReturnValue([]);
  mocks.hygiene.mockReturnValue({ abandoned: [], stale: [] });
});

describe('default needs-you reader (MCP)', () => {
  it('admits only approvals in the viewer tenant and tier, never personal ones', () => {
    mocks.approvals.mockReturnValue([
      record('mine', { tenant_slug: 'famao-ai', tier: 'confidential' }),
      record('other', { tenant_slug: 'acme', tier: 'confidential' }),
      record('personal', { tier: 'personal' }),
      record('unscoped', undefined),
      record('public', { tier: 'public' }),
    ]);
    const data = readNeedsYouSources(viewer);
    expect(data.approvals.map((item) => item.id).sort()).toEqual(['mine', 'public']);
    expect(mocks.approvals).toHaveBeenCalledWith({ status: 'pending' });
  });

  it('reads only open deliverable entries of the viewer tenant', () => {
    mocks.approvals.mockReturnValue([]);
    mocks.inbox.mockReturnValue([
      {
        entry_id: 'e1',
        title: 't',
        summary: '',
        artifact_paths: [],
        status: 'unread',
        updated_at: '',
        created_at: '',
        tenant_slug: 'famao-ai',
      },
      {
        entry_id: 'e2',
        title: 't',
        summary: '',
        artifact_paths: [],
        status: 'unread',
        updated_at: '',
        created_at: '',
        tenant_slug: 'acme',
      },
    ]);
    expect(readNeedsYouSources(viewer).outcomes.map((item) => item.entry_id)).toEqual(['e1']);
  });

  it('keeps the queue readable when one store fails', () => {
    mocks.approvals.mockImplementation(() => {
      throw new Error('store down');
    });
    const data = readNeedsYouSources(viewer);
    expect(data.approvals).toEqual([]);
    expect(data.outcomes).toEqual([]);
  });
});
