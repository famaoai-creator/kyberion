import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  update: vi.fn(),
  promote: vi.fn(),
  notify: vi.fn(),
}));
vi.mock('../../../lib/distill-candidate-scope', () => ({
  resolveDistillCandidateForViewer: mocks.resolve,
  DistillCandidateAmbiguityError: class extends Error {},
}));
vi.mock('../../../lib/intelligence-primitives', () => ({
  updateDistillCandidateRecord: mocks.update,
  savePromotedMemoryRecord: mocks.promote,
  enqueueSurfaceNotification: mocks.notify,
}));
vi.mock('./intelligence-observation-data', () => ({ buildLearnedNotificationText: () => '' }));
vi.mock('./intelligence-control-data', () => ({}));
import { INTELLIGENCE_ACTION_HANDLERS } from './actions';
import { DistillCandidateAmbiguityError } from '../../../lib/distill-candidate-scope';
import { parseChronosIntelligenceInput } from './intelligence-input';
const scope = {
  tier: 'confidential' as const,
  tenant_slug: 'acme',
  organization_id: 'org-a',
  project_id: 'proj-a',
  provenance_refs: ['recording:one'],
};
const row = { candidate_id: 'DSC-TEST', title: 'private title', scope, status: 'proposed' };
const resolvedViewer = {
  context: {
    role: 'localadmin' as const,
    source: 'token' as const,
    tenantSlugs: ['acme'],
    organizationIds: ['org-a'],
    projectIds: ['proj-a'],
    tierAccess: ['public' as const, 'confidential' as const],
  },
};
const run = (decision: 'archive' | 'promote' = 'archive') =>
  INTELLIGENCE_ACTION_HANDLERS.distill_candidate_decision(
    { action: 'distill_candidate_decision', candidateId: 'DSC-TEST', decision, tenant: 'acme' },
    resolvedViewer,
    'distill_candidate_decision'
  );
beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockReturnValue(row);
  mocks.update.mockImplementation((_id, patch) => ({ ...row, ...patch }));
  mocks.promote.mockReturnValue({ logicalPath: 'knowledge/confidential/acme/approved.md' });
});
describe('scoped distill decision', () => {
  it('archives with exact server-resolved scope without publishing its private title', async () => {
    expect((await run()).status).toBe(200);
    expect(mocks.resolve).toHaveBeenCalledWith('DSC-TEST', resolvedViewer.context, 'acme');
    expect(mocks.update).toHaveBeenCalledWith('DSC-TEST', { status: 'archived' }, scope);
    expect(mocks.notify).not.toHaveBeenCalled();
  });
  it('preserves legacy notifications without admitting scoped content', async () => {
    const legacy = { ...row, scope: undefined };
    mocks.resolve.mockReturnValue(legacy);
    mocks.update.mockReturnValue({ ...legacy, status: 'archived' });
    expect((await run()).status).toBe(200);
    expect(mocks.notify).toHaveBeenCalledOnce();
    expect(mocks.notify.mock.calls[0][0]).not.toHaveProperty('scope');
  });
  it('promotes through the existing canonical publication guard and updates same scope', async () => {
    expect((await run('promote')).status).toBe(200);
    expect(mocks.promote).toHaveBeenCalledWith(row, { executionRole: 'chronos_gateway' });
    expect(mocks.update).toHaveBeenCalledWith(
      'DSC-TEST',
      { status: 'promoted', promoted_ref: 'knowledge/confidential/acme/approved.md' },
      scope
    );
  });
  it('does not mutate or notify when invisible', async () => {
    mocks.resolve.mockReturnValue(null);
    expect((await run()).status).toBe(404);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });
  it('returns conflict for ambiguous ids without writing', async () => {
    mocks.resolve.mockImplementation(() => {
      throw new DistillCandidateAmbiguityError('ambiguous');
    });
    expect((await run()).status).toBe(409);
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it.each([{ owner_nhi: 'user:reviewer' }, { allowed_audience: ['user:reviewer'] }])(
    'does not widen restricted notifications %j',
    async (restriction) => {
      const restricted = { ...row, scope: { ...scope, ...restriction } };
      mocks.resolve.mockReturnValue(restricted);
      mocks.update.mockReturnValue({ ...restricted, status: 'archived' });
      expect((await run()).status).toBe(200);
      expect(mocks.notify).not.toHaveBeenCalled();
    }
  );
  it('does not notify or report success if the exact-scope update disappears', async () => {
    mocks.update.mockReturnValue(null);
    expect((await run()).status).toBe(409);
    expect(mocks.notify).not.toHaveBeenCalled();
  });
  it('preserves canonical promotion rejection without updating or notifying', async () => {
    mocks.promote.mockImplementation(() => {
      throw new Error('[LEARNING_APPROVAL_REQUIRED]');
    });
    await expect(run('promote')).rejects.toThrow('[LEARNING_APPROVAL_REQUIRED]');
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.notify).not.toHaveBeenCalled();
  });
  it('rejects client-supplied scope rather than trusting it', () => {
    expect(() =>
      parseChronosIntelligenceInput({
        action: 'distill_candidate_decision',
        candidateId: 'DSC-TEST',
        decision: 'archive',
        scope,
      })
    ).toThrow();
  });
});
