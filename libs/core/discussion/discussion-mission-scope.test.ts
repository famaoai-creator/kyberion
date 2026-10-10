import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  scope: {
    tenant_slug: 'acme',
    organization_id: 'org-a',
    project_id: 'prj-a',
    tier: 'confidential',
  } as Record<string, unknown>,
  approvalScope: {
    tenant_slug: 'acme',
    organization_id: 'org-a',
    project_id: 'prj-a',
    tier: 'confidential',
  } as Record<string, unknown>,
  status: 'approved',
  issue: vi.fn(async () => ({ missionId: 'MSN-TEST', orchestrationStatus: 'queued' })),
  append: vi.fn(),
}));
vi.mock('../authority.js', () => ({
  withExecutionContext: (_: unknown, fn: () => unknown) => fn(),
}));
vi.mock('../governance/approval-linked-usability.js', () => ({
  approvalUsabilityRefusal: () => undefined,
}));
vi.mock('../governance/approval-store.js', () => ({
  createApprovalRequest: vi.fn(),
  evaluateApprovalUsability: () => undefined,
  loadApprovalRequest: () => ({ status: mocks.status, scope: mocks.approvalScope }),
}));
vi.mock('../surface/surface-mission-proposals.js', () => ({
  issueChronosMissionFromProposal: mocks.issue,
}));
vi.mock('../workforce/artifact-record.js', () => ({
  loadArtifactRecord: vi.fn(),
  saveArtifactRecord: vi.fn(),
}));
vi.mock('../workforce/work-coordination.js', () => ({
  getWorkItem: vi.fn(),
  updateWorkItem: vi.fn(),
}));
vi.mock('../core.js', () => ({ logger: { error: vi.fn(), warn: vi.fn() } }));
vi.mock('./discussion-copy.js', () => ({ fillCopy: vi.fn(), loadDiscussionCopy: vi.fn() }));
vi.mock('./discussion-store.js', () => ({
  DiscussionUserError: class DiscussionUserError extends Error {},
  appendDiscussionEvent: mocks.append,
  readDiscussionRoom: () => ({
    id: 'room-1',
    decision: { summary: 'Decision' },
    goal: 'Goal',
    scope: mocks.scope,
    outcomes: {
      mission: { approval_id: 'approval-1', approval_channel: 'chronos' },
      work_items: {},
    },
  }),
}));
import { issueMissionForDiscussion } from './discussion-mission.js';
describe('discussion approved hierarchy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.status = 'approved';
    mocks.scope = {
      tenant_slug: 'acme',
      organization_id: 'org-a',
      project_id: 'prj-a',
      tier: 'confidential',
    };
    mocks.approvalScope = { ...mocks.scope };
  });
  it('forwards exactly the approved stored hierarchy', async () => {
    await issueMissionForDiscussion('room-1', 'owner');
    expect(mocks.issue).toHaveBeenCalledWith(expect.objectContaining({ scope: mocks.scope }));
  });
  it.each(['tenant_slug', 'organization_id', 'project_id', 'tier'])(
    'rejects changed approved %s before issuance',
    async (key) => {
      mocks.approvalScope[key] = key === 'tier' ? 'public' : 'different';
      await expect(issueMissionForDiscussion('room-1', 'owner')).rejects.toThrow(/scope/);
      expect(mocks.issue).not.toHaveBeenCalled();
      expect(mocks.append).not.toHaveBeenCalled();
    }
  );
  it.each([
    { tenant_slug: 'acme', project_id: 'prj-a' },
    { tenant_slug: 'shared' },
    { tenant_slug: 'acme', mission_id: 'MSN-EXISTING' },
    { tenant_slug: 'acme', organization_id: 42 },
    { tenant_slug: 'acme', organization_id: '' },
  ])('rejects malformed stored scope %j', async (scope) => {
    mocks.scope = scope;
    await expect(issueMissionForDiscussion('room-1', 'owner')).rejects.toThrow();
    expect(mocks.issue).not.toHaveBeenCalled();
  });
  it('keeps the approval gate in front of the scoped issuance', async () => {
    mocks.status = 'pending';
    await expect(issueMissionForDiscussion('room-1', 'owner')).rejects.toThrow(/not been approved/);
    expect(mocks.issue).not.toHaveBeenCalled();
  });
});
