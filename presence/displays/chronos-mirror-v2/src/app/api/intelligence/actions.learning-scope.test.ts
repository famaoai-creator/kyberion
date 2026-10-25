import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  decide: vi.fn(),
  visible: vi.fn(),
  member: vi.fn(),
  notify: vi.fn(),
}));
vi.mock('../../../lib/scoped-learning-approval-visibility', () => ({
  scopedLearningApprovalVisibleToViewer: mocks.visible,
}));
vi.mock('../../../lib/intelligence-primitives', () => ({
  loadApprovalRequest: mocks.load,
  decideApprovalRequest: mocks.decide,
  enqueueSurfaceNotification: mocks.notify,
  normalizeRejectionReasonCategory: () => undefined,
  surfaceDecisionAuthMethod: () => 'surface_session',
  surfaceDecisionBinding: () => ({ presentedDigest: 'shown-digest' }),
}));
vi.mock('@agent/core/organization/member-registry', () => ({
  resolveMemberByPrincipal: mocks.member,
  memberBindingDenied: () => false,
}));
vi.mock('./intelligence-observation-data', () => ({ buildApprovalDecisionText: () => 'decision' }));
vi.mock('./intelligence-control-data', () => ({}));
import { INTELLIGENCE_ACTION_HANDLERS } from './actions';
const scope = {
  tier: 'confidential',
  tenant_slug: 'acme',
  organization_id: 'org-a',
  project_id: 'proj-a',
};
const row = {
  id: 'review',
  scope,
  status: 'pending',
  accountability: { effectBinding: 'scoped-learning:bound' },
  title: 'private title',
};
const viewer = {
  context: {
    role: 'localadmin' as const,
    source: 'token' as const,
    principalId: 'member:reviewer',
    tenantSlugs: ['acme'],
    organizationIds: ['org-a'],
    projectIds: ['proj-a'],
  },
};
const run = (tenant = 'acme') =>
  INTELLIGENCE_ACTION_HANDLERS.approval_decision(
    {
      action: 'approval_decision',
      requestId: 'review',
      storageChannel: 'terminal',
      channel: 'terminal',
      decision: 'approved',
      tenant,
      presentedDigest: 'shown-digest',
    },
    viewer,
    'approval_decision'
  );
beforeEach(() => {
  vi.clearAllMocks();
  mocks.load.mockReturnValue(row);
  mocks.visible.mockReturnValue(true);
  mocks.member.mockReturnValue({
    member_id: 'reviewer',
    memberships: [{ tenant_slug: 'acme', role: 'approver' }],
  });
  mocks.decide.mockReturnValue({ ...row, status: 'approved' });
});
describe('scoped learning shared decision boundary', () => {
  it.each(['pending', 'approved', 'rejected'])(
    'hides unavailable %s requests before membership, mutation or notification',
    async (status) => {
      mocks.load.mockReturnValue({ ...row, status });
      mocks.visible.mockReturnValue(false);
      expect((await run()).status).toBe(404);
      expect(mocks.visible).toHaveBeenCalledWith(
        expect.objectContaining({ status }),
        viewer.context,
        'acme'
      );
      expect(mocks.member).not.toHaveBeenCalled();
      expect(mocks.decide).not.toHaveBeenCalled();
      expect(mocks.notify).not.toHaveBeenCalled();
    }
  );
  it('records an authorized exact request without publishing private summary into shared notifications', async () => {
    expect((await run()).status).toBe(200);
    expect(mocks.decide).toHaveBeenCalledWith(
      'chronos_localadmin',
      expect.objectContaining({
        requestId: 'review',
        storageChannel: 'terminal',
        presentedDigest: 'shown-digest',
        decidedBy: 'user:reviewer',
        decidedByRole: 'approver',
      })
    );
    expect(mocks.notify).not.toHaveBeenCalled();
  });
  it('still rejects a downgraded current member', async () => {
    mocks.member.mockReturnValue({
      member_id: 'reviewer',
      memberships: [{ tenant_slug: 'acme', role: 'viewer' }],
    });
    expect((await run()).status).toBe(403);
    expect(mocks.decide).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });
  it('does not let a tenant query widen the server viewer', async () => {
    await expect(run('foreign')).rejects.toThrow('viewer tenant scope denied');
    expect(mocks.decide).not.toHaveBeenCalled();
  });
  it('preserves legacy notifications for unrelated approvals', async () => {
    mocks.decide.mockReturnValue({ ...row, accountability: undefined, status: 'approved' });
    expect((await run()).status).toBe(200);
    expect(mocks.notify).toHaveBeenCalledOnce();
  });
});
