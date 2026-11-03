import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ list: vi.fn(), visible: vi.fn() }));
vi.mock('@agent/core/governance/approval-store', () => ({
  listApprovalRequests: mocks.list,
  computeApprovalPresentedDigest: () => 'shown-digest',
}));
vi.mock('./scoped-learning-approval-visibility', () => ({
  scopedLearningApprovalVisibleToViewer: mocks.visible,
}));
import { buildApprovalQueueItems } from './su-surface-data';
const target = {
  id: 'exact-review',
  channel: 'terminal',
  storageChannel: 'terminal',
  status: 'approved',
  kind: 'mission_gate',
  title: 'Scoped SOP',
  summary: 'scope summary',
  details: 'private content',
  requestedAt: '2026-10-01T00:00:00Z',
  requestedBy: 'user:requester',
  scope: {
    tier: 'confidential',
    tenant_slug: 'acme',
    organization_id: 'org-a',
    project_id: 'proj-a',
  },
};
const viewer = {
  role: 'localadmin' as const,
  source: 'token' as const,
  tenantSlugs: ['acme'],
  organizationIds: ['org-a'],
  projectIds: ['proj-a'],
};
beforeEach(() => {
  mocks.visible.mockReturnValue(true);
  mocks.list.mockReturnValue([target]);
});
describe('exact scoped learning review lookup', () => {
  it.each(['approved', 'rejected', 'cancelled'])(
    'finds %s mission-less review before queue limit',
    (status) => {
      const other = Array.from({ length: 60 }, (_, i) => ({
        ...target,
        id: 'other-' + i,
        requestedAt: '2026-10-20T00:00:00Z',
      }));
      mocks.list.mockReturnValue([...other, { ...target, status }]);
      const rows = buildApprovalQueueItems({
        requestId: target.id,
        storageChannel: 'terminal',
        viewer,
        tenantSlugs: ['acme'],
        limit: 1,
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: target.id,
        status,
        details: 'private content',
        presentedDigest: 'shown-digest',
      });
    }
  );
  it('disambiguates storage channels', () => {
    mocks.list.mockReturnValue([
      { ...target, storageChannel: 'slack', title: 'different' },
      target,
    ]);
    expect(
      buildApprovalQueueItems({ requestId: target.id, storageChannel: 'terminal', viewer })
    ).toHaveLength(1);
    expect(
      buildApprovalQueueItems({ requestId: 'missing', storageChannel: 'terminal', viewer })
    ).toEqual([]);
  });
  it('withholds unauthorized or stale scoped review before fields and digest projection', () => {
    mocks.visible.mockReturnValue(false);
    expect(
      buildApprovalQueueItems({ requestId: target.id, storageChannel: 'terminal', viewer })
    ).toEqual([]);
    expect(mocks.visible).toHaveBeenCalledWith(target, viewer, undefined);
  });
  it('passes only server viewer authorization and requested tenant narrowing', () => {
    buildApprovalQueueItems({ viewer, tenant: 'acme', tenantSlugs: ['acme'] });
    expect(mocks.visible).toHaveBeenCalledWith(target, viewer, 'acme');
    expect(buildApprovalQueueItems({ viewer, tenantSlugs: ['other'] })).toEqual([]);
  });
});
