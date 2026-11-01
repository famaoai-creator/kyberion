/** Resolve only the exact canonical action bound to the visible approval, never an evidence path. */
import type { ApprovalRequestRecord } from '@agent/core/governance/approval-store';
import { findDotCharter } from '@agent/core/dot/dot-charter';
import { readDotActionLedgerStrict } from '@agent/core/dot/dot-action-ledger';
import { withConciergeApproval } from './personal-approval-server';
import type { ConciergeViewerContext } from './viewer-context';

export function conciergeApprovalReviewScope(
  viewer: ConciergeViewerContext,
  approval: ApprovalRequestRecord
): string | undefined {
  const binding = approval.accountability?.effectBinding;
  const hash = approval.accountability?.payloadHash;
  const actor = approval.source?.agentId;
  if (
    !binding?.startsWith('continuous-work:') ||
    !hash ||
    !/^[a-f0-9]{64}$/u.test(hash) ||
    !actor?.startsWith('dot:')
  )
    return undefined;
  return (
    withConciergeApproval(viewer, approval, () => {
      const dotId = actor.slice(4);
      const owner = findDotCharter(dotId)?.charter;
      if (
        !owner ||
        owner.scope.tier !== approval.scope?.tier ||
        owner.scope.tenant_slug !== approval.scope?.tenant_slug ||
        owner.scope.owner_nhi !== approval.scope?.nhi_id ||
        (Boolean(owner.scope.tenant_slug) &&
          (owner.scope.organization_id !== approval.scope?.organization_id ||
            owner.scope.project_id !== approval.scope?.project_id))
      )
        throw new Error('Approval owner scope does not match the canonical development action');
      const action = readDotActionLedgerStrict({ dotId }).find(
        (row) =>
          row.action_ref === binding.slice('continuous-work:'.length) &&
          row.admission?.semantic_hash === hash &&
          row.continuous_work
      );
      if (!action)
        throw new Error(
          'Approval review scope is unavailable; restore the exact action evidence before deciding'
        );
      return JSON.stringify(
        {
          action_ref: action.action_ref,
          admission_sha256: hash,
          scope: owner.scope,
          plan: action.continuous_work,
          proposal: action.admission?.proposal,
        },
        null,
        2
      );
    }) ?? undefined
  );
}
