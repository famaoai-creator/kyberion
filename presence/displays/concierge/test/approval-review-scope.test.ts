import { describe, expect, it, vi } from 'vitest';
import type { ApprovalRequestRecord } from '@agent/core/governance/approval-store';
import type { ConciergeViewerContext } from '../src/lib/viewer-context';
const deps = vi.hoisted(() => ({ charter: vi.fn(), ledger: vi.fn() }));
vi.mock('@agent/core/dot/dot-charter', () => ({ findDotCharter: deps.charter }));
vi.mock('@agent/core/dot/dot-action-ledger', () => ({ readDotActionLedgerStrict: deps.ledger }));
vi.mock('../src/lib/personal-approval-server', () => ({
  withConciergeApproval: (_viewer: unknown, _record: unknown, run: () => unknown) => run(),
}));
import { conciergeApprovalReviewScope } from '../src/lib/approval-review-scope';
const approval = {
  scope: { tier: 'personal', nhi_id: 'owner' },
  source: { agentId: 'dot:synthetic' },
  accountability: { effectBinding: 'continuous-work:action-one', payloadHash: 'a'.repeat(64) },
} as ApprovalRequestRecord;
describe('visible approval full review descriptor', () => {
  it('returns every exact path for only the bound action/hash, using canonical scoped ledger rather than evidence refs', () => {
    deps.charter.mockReturnValue({
      charter: { scope: { tier: 'personal', owner_nhi: 'owner', organization_id: 'ops' } },
    });
    const paths = Array.from({ length: 64 }, (_, i) => `libs/core/source-${i}.ts`);
    deps.ledger.mockReturnValue([
      {
        action_ref: 'action-one',
        admission: { semantic_hash: 'a'.repeat(64) },
        continuous_work: { missions: [{ development: { source_edit_paths: paths } }] },
      },
    ]);
    const review = conciergeApprovalReviewScope({} as ConciergeViewerContext, approval)!;
    expect(JSON.parse(review).plan.missions[0].development.source_edit_paths).toEqual(paths);
    expect(deps.ledger).toHaveBeenCalledWith({ dotId: 'synthetic' });
    expect(() =>
      conciergeApprovalReviewScope(
        {} as ConciergeViewerContext,
        {
          ...approval,
          accountability: { ...approval.accountability, payloadHash: 'b'.repeat(64) },
        } as ApprovalRequestRecord
      )
    ).toThrow('unavailable');
  });
  it('never hydrates another owner ledger', () => {
    deps.charter.mockReturnValue({
      charter: { scope: { tier: 'personal', owner_nhi: 'foreign' } },
    });
    deps.ledger.mockClear();
    expect(() => conciergeApprovalReviewScope({} as ConciergeViewerContext, approval)).toThrow(
      'owner scope'
    );
    expect(deps.ledger).not.toHaveBeenCalled();
  });
});
