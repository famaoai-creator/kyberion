/** Shared state-independent first-job bindings. These checks grant no authority. */
import type { DotCharter } from '../dot/dot-charter.js';
import { dotProposalHash, type DotActionRecord } from '../dot/dot-action-ledger.js';
import {
  computeApprovalPayloadHash,
  type ApprovalRequestRecord,
} from '../governance/approval-store.js';
import type { FrontDeskExecutionBinding } from './front-desk-execution-contract.js';
import {
  frontDeskBindingsEqual,
  frontDeskExecutionProposal,
} from './front-desk-execution-proposal.js';
import type { FirstJobApprovalEffect } from './first-job-approval-proof.js';

/** Callers independently require the appropriate state, uniqueness and decision. */
export function firstJobActionMatches(
  charter: DotCharter,
  binding: FrontDeskExecutionBinding,
  action: DotActionRecord | undefined
): action is DotActionRecord {
  if (!action) return false;
  const expected = frontDeskExecutionProposal(binding);
  return (
    action.dot_id === charter.dot_id &&
    action.actor_id === 'dot:' + charter.dot_id &&
    action.action_id === expected.action_id &&
    action.work_shape === expected.work_shape &&
    action.pipeline_ref === expected.pipeline_ref &&
    action.target === expected.target &&
    action.intent === expected.intent &&
    !action.handoff_to &&
    action.proposal_hash === dotProposalHash(charter.dot_id, expected) &&
    frontDeskBindingsEqual(binding, action.front_desk_execution)
  );
}

/** Pending decisions and completed decisions share precisely this effect binding. */
export function firstJobApprovalMatches(
  charter: DotCharter,
  approvalId: string,
  effect: FirstJobApprovalEffect,
  record: ApprovalRequestRecord | null | undefined
): record is ApprovalRequestRecord {
  return Boolean(
    record &&
    record.id === approvalId &&
    record.storageChannel === 'autonomy' &&
    record.kind === 'channel-approval' &&
    record.requestedBy === 'dot:' + charter.dot_id &&
    record.accountability?.finalDecision === 'human_only' &&
    record.accountability.payloadHash === effect.payloadHash &&
    record.accountability.effectBinding === effect.effectBinding &&
    computeApprovalPayloadHash({ scope: record.scope }) ===
      computeApprovalPayloadHash({ scope: effect.effect.scope }) &&
    !record.target &&
    !record.steering &&
    !record.workflow &&
    !record.veto
  );
}
