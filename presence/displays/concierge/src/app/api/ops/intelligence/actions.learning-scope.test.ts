import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  decide: vi.fn(),
  visible: vi.fn(),
  member: vi.fn(),
  notify: vi.fn(),
}));
vi.mock('../../../../lib/ops/scoped-learning-approval-visibility', () => ({
  scopedLearningApprovalVisibleToViewer: mocks.visible,
}));
vi.mock('../../../../lib/ops/intelligence-primitives', () => ({
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
// Exercise all-scope and finite-scope viewers through the same decision path.
const runAsAll = (overrides: Record<string, unknown> = {}, tenant?: string) =>
  INTELLIGENCE_ACTION_HANDLERS.approval_decision(
    {
      action: 'approval_decision',
      requestId: 'review',
      storageChannel: 'terminal',
      channel: 'terminal',
      decision: 'approved',
      presentedDigest: 'shown-digest',
      ...(tenant ? { tenant } : {}),
    },
    {
      context: {
        ...viewer.context,
        tenantSlugs: 'all' as const,
        organizationIds: 'all' as const,
        projectIds: 'all' as const,
        ...overrides,
      },
    },
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
  it.each(['owner_nhi', 'nhi_id'] as const)(
    'denies a person-custody request to an all-scope viewer who is not the owner (%s)',
    async (personField) => {
      mocks.load.mockReturnValue({
        ...row,
        scope: { tier: 'confidential', [personField]: 'human:alice' },
      });
      expect((await runAsAll()).status).toBe(403);
      expect(mocks.decide).not.toHaveBeenCalled();
      expect(mocks.notify).not.toHaveBeenCalled();
    }
  );
  it('still denies a person-custody request when no member resolves', async () => {
    mocks.load.mockReturnValue({
      ...row,
      // `nhi_id` is the governed (event-scope) person-binding field.
      scope: { tier: 'confidential', nhi_id: 'human:alice' },
    });
    mocks.member.mockReturnValue(undefined);
    expect((await runAsAll()).status).toBe(403);
    expect(mocks.decide).not.toHaveBeenCalled();
  });
  it('admits the owner of a person-custody request', async () => {
    mocks.load.mockReturnValue({
      ...row,
      scope: { tier: 'confidential', nhi_id: 'human:alice' },
    });
    mocks.member.mockReturnValue({
      member_id: 'alice',
      memberships: [{ tenant_slug: 'acme', role: 'owner' }],
    });
    expect((await runAsAll({ principalId: 'human:alice' })).status).toBe(200);
    expect(mocks.decide).toHaveBeenCalledWith(
      'chronos_localadmin',
      expect.objectContaining({ requestId: 'review', decidedBy: 'user:alice' })
    );
  });
  it('admits the exact owner with finite tenant scope and rejects malformed alias bindings', async () => {
    mocks.member.mockReturnValue({
      member_id: 'alice',
      memberships: [{ tenant_slug: 'acme', role: 'owner' }],
    });
    mocks.load.mockReturnValue({ ...row, scope: { tier: 'confidential', nhi_id: 'human:alice' } });
    expect((await runAsAll({ principalId: 'human:alice', tenantSlugs: ['acme'] })).status).toBe(
      200
    );
    mocks.decide.mockClear();
    expect(
      (await runAsAll({ principalId: 'human:alice', tenantSlugs: ['acme'] }, 'acme')).status
    ).toBe(403);
    expect(mocks.decide).not.toHaveBeenCalled();
    for (const scope of [
      { owner_nhi: '', nhi_id: 'human:alice' },
      { owner_nhi: 'human:alice', nhi_id: 'human:bob' },
    ]) {
      mocks.decide.mockClear();
      mocks.load.mockReturnValue({ ...row, scope: { tier: 'confidential', ...scope } });
      expect((await runAsAll({ principalId: 'human:alice' })).status).toBe(403);
      expect(mocks.decide).not.toHaveBeenCalled();
    }
  });
  it('treats a tenant-scoped record as tenant custody even with owner_nhi set', async () => {
    mocks.load.mockReturnValue({
      ...row,
      scope: { ...scope, owner_nhi: 'human:alice' },
    });
    expect((await run()).status).toBe(200);
    expect(mocks.decide).toHaveBeenCalledWith(
      'chronos_localadmin',
      expect.objectContaining({ decidedBy: 'user:reviewer', decidedByRole: 'approver' })
    );
  });
});
