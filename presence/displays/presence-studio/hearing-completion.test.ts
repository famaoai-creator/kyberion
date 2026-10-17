import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ mission: vi.fn(), approval: vi.fn(), inventory: vi.fn() }));
vi.mock('@agent/core/mission/mission-state', async () => ({
  ...(await vi.importActual('@agent/core/mission/mission-state')),
  loadState: mocks.mission,
}));
vi.mock('@agent/core/governance/approval-store', async () => ({
  ...(await vi.importActual('@agent/core/governance/approval-store')),
  loadApprovalRequest: mocks.approval,
}));
vi.mock('@agent/core/workforce/work-inventory', async () => ({
  ...(await vi.importActual('@agent/core/workforce/work-inventory')),
  loadWorkInventoryEntry: mocks.inventory,
}));
vi.mock('@agent/core/front-desk-nav', async () => ({
  ...(await vi.importActual('@agent/core/front-desk-nav')),
  readFrontDeskSurfaceUrls: () => ({
    concierge: 'https://review.example.test',
    'presence-studio': 'https://ask.example.test',
  }),
}));
import { readHearingCompletion, withoutHearingCompletionFields } from './hearing-completion.js';
import type { HearingRecord } from './hearing.js';
import type { PresenceStudioViewerContext } from './security.js';
const viewer: PresenceStudioViewerContext = {
  principalId: 'human:test',
  source: 'loopback',
  tenantSlugs: ['alpha'],
};
const missionId = 'MSN-TEST';
const approvalId = '00000000-0000-4000-8000-000000000001';
const decision = {
  decided_by: { kind: 'human', id: 'user:test' },
  decided_at: '2026-10-17T00:00:00Z',
  requirements: [{ id: 'goal', answer: 'Saved' }],
};
const record = (extra = {}) =>
  ({
    ...decision,
    scenario: 'web_app_build',
    mission_id: missionId,
    approval_request_id: approvalId,
    ...extra,
  }) as unknown as HearingRecord;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.mission.mockReturnValue({
    mission_id: missionId,
    tenant_slug: 'alpha',
    status: 'completed',
  });
  mocks.approval.mockReturnValue({
    id: approvalId,
    kind: 'mission_gate',
    status: 'approved',
    source: { missionId },
    correlationId: 'mission-alignment-' + missionId,
  });
  mocks.inventory.mockReturnValue({
    entry_id: 'entry-1',
    scope: { tenant_slug: 'alpha' },
    status: 'confirmed',
  });
});
describe('hearing completion read model', () => {
  it('restores a verified mission handoff with configured tenant-scoped destination', () => {
    expect(readHearingCompletion(record(), viewer)).toEqual({
      kind: 'mission',
      status: 'ready',
      id: missionId,
      next: { href: 'https://review.example.test/?tenant=alpha' },
    });
    expect(mocks.approval).toHaveBeenCalledWith('brief', approvalId);
  });
  it.each([{ approval_request_id: undefined }, { mission_id: undefined }])(
    'keeps partial handoffs unavailable',
    (partial) => {
      expect(readHearingCompletion(record(partial), viewer)).toEqual({
        kind: 'mission',
        status: 'unavailable',
      });
    }
  );
  it('does not leak a foreign mission or read its approval', () => {
    mocks.mission.mockReturnValue({ mission_id: missionId, tenant_slug: 'beta' });
    expect(readHearingCompletion(record(), viewer)).toEqual({
      kind: 'mission',
      status: 'unavailable',
    });
    expect(mocks.approval).not.toHaveBeenCalled();
  });
  it.each(['missing', 'wrong-mission', 'wrong-correlation', 'foreign-scope'])(
    'rejects %s approval',
    (mode) => {
      const approval = mocks.approval();
      mocks.approval.mockReturnValue(
        mode === 'missing'
          ? null
          : {
              ...approval,
              ...(mode === 'wrong-mission' ? { source: { missionId: 'MSN-OTHER' } } : {}),
              ...(mode === 'wrong-correlation' ? { correlationId: 'other' } : {}),
              ...(mode === 'foreign-scope' ? { scope: { tenant_slug: 'beta' } } : {}),
            }
      );
      expect(readHearingCompletion(record(), viewer)).toEqual({
        kind: 'mission',
        status: 'unavailable',
      });
    }
  );
  it('keeps deleted or unreadable targets unavailable', () => {
    mocks.mission.mockReturnValue(null);
    expect(readHearingCompletion(record(), viewer)?.status).toBe('unavailable');
    mocks.mission.mockImplementation(() => {
      throw new Error('private details');
    });
    expect(readHearingCompletion(record(), viewer)?.status).toBe('unavailable');
  });
  it('restores inventory through the viewer-derived scope', () => {
    const hearing = {
      ...decision,
      scenario: 'work_inventory',
      work_inventory_entry_id: 'entry-1',
      work_inventory_scope: { tenant_slug: 'alpha' },
    } as unknown as HearingRecord;
    expect(readHearingCompletion(hearing, viewer)).toEqual({
      kind: 'inventory',
      status: 'ready',
      id: 'entry-1',
      next: { href: '/progress?tenant=alpha' },
    });
    expect(mocks.inventory).toHaveBeenCalledWith({ tenant_slug: 'alpha' }, 'entry-1');
    mocks.inventory.mockReturnValue(null);
    expect(readHearingCompletion(hearing, viewer)?.status).toBe('unavailable');
  });
  it('refuses persisted inventory scope widening', () => {
    const hearing = {
      ...decision,
      scenario: 'work_inventory',
      work_inventory_entry_id: 'entry-1',
      work_inventory_scope: { tenant_slug: 'beta' },
    } as unknown as HearingRecord;
    expect(readHearingCompletion(hearing, viewer)).toEqual({
      kind: 'inventory',
      status: 'unavailable',
    });
    expect(mocks.inventory).not.toHaveBeenCalled();
  });
  it('removes raw completion identifiers and scope without mutating storage', () => {
    const hearing = record({
      work_inventory_entry_id: 'secret',
      work_inventory_scope: { tenant_slug: 'beta' },
      work_inventory_steps: 3,
      handed_off_at: 'date',
    });
    expect(withoutHearingCompletionFields(hearing)).toEqual({
      ...decision,
      scenario: 'web_app_build',
    });
    expect(hearing).toHaveProperty('mission_id', missionId);
  });
  it('supports local personal inventory while refusing remote personal access', () => {
    const hearing = {
      ...decision,
      scenario: 'work_inventory',
      work_inventory_entry_id: 'entry-1',
      work_inventory_scope: {},
    } as unknown as HearingRecord;
    mocks.inventory.mockReturnValue({ entry_id: 'entry-1', scope: {}, status: 'confirmed' });
    for (const tenantSlugs of [[], 'all'] as const) {
      expect(
        readHearingCompletion(hearing, {
          ...viewer,
          source: 'loopback',
          tenantSlugs: tenantSlugs === 'all' ? 'all' : [],
        })?.status
      ).toBe('ready');
    }
    expect(
      readHearingCompletion(hearing, { ...viewer, source: 'token', tenantSlugs: [] })?.status
    ).toBe('unavailable');
  });
  it.each([{ organizationIds: ['org-a'] }, { projectIds: ['project-a'] }])(
    'rejects a target outside a narrower selection',
    (selection) => {
      expect(readHearingCompletion(record(), { ...viewer, ...selection })?.status).toBe(
        'unavailable'
      );
    }
  );
  it.each([
    { decided_at: undefined },
    { decided_by: undefined },
    { requirements: [{ id: 'goal' }] },
    { scenario: 'work_inventory' },
  ])('refuses incomplete decisions and wrong-scenario markers', (change) => {
    expect(readHearingCompletion(record(change), viewer)).toEqual({
      kind: 'mission',
      status: 'unavailable',
    });
  });
  it('does not offer a privileged destination to readonly viewers', () => {
    expect(readHearingCompletion(record(), { ...viewer, source: 'token' })).toEqual({
      kind: 'mission',
      status: 'unavailable',
    });
  });
  it('does not mark an ordinary decided hearing complete', () => {
    expect(
      readHearingCompletion(
        { scenario: 'web_app_build', decided_at: 'date' } as HearingRecord,
        viewer
      )
    ).toBeUndefined();
  });
});
