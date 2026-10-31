/** Exact approval identity for synthetic judgments. No origin proof, new policy or authority. */
import { normalizeEventScope } from '../event-scope.js';
import { judgmentCanonicalHash } from '../organization/judgment-precedents.js';
import {
  loadApprovalRequest,
  isApprovalRequestExpired,
  type ApprovalRequestRecord,
} from '../governance/approval-store.js';
import { approvalUsabilityRefusal } from '../governance/approval-linked-usability.js';
import { AUTONOMY_APPROVAL_CHANNEL } from '../governance/approval-decision-card.js';
import type { RouteAutonomousDecisionInput } from '../governance/approval-decision-routing.js';
import { assertDotActionJudgmentBinding, type DotActionRecord } from './dot-action-ledger.js';
import { assertDotJudgmentProposalCharter } from './dot-admission-identity.js';
import { parseDotJudgmentBinding } from './dot-judgment-binding.js';
import { proposalActionIdentity } from './dot-proposals.js';
import {
  hasDotFeedbackFor,
  recordDotFeedback,
  type DotFeedbackDeps,
  type DotFeedbackOutcome,
} from './dot-feedback.js';
import type { DotCharter } from './dot-charter.js';
import type { DotDispatchDeps } from './dot-dispatch.js';

function identity(charter: DotCharter, record: DotActionRecord) {
  assertDotActionJudgmentBinding(record);
  const binding = parseDotJudgmentBinding(record.semantic_judgment);
  if (!binding) return undefined;
  assertDotJudgmentProposalCharter(charter, record.admission!.proposal);
  if (
    record.dot_id !== charter.dot_id ||
    record.actor_id !== `dot:${charter.dot_id}` ||
    !record.action_ref ||
    record.action_ref !== record.action_ref.trim()
  )
    throw new Error('Judgment action ownership differs');
  return {
    accountability: {
      payloadHash: record.admission!.semantic_hash,
      effectBinding: `dot-judgment:${record.action_ref}`,
    },
    scope: normalizeEventScope(binding.scope),
    source: {
      agentId: record.actor_id,
      actionId: proposalActionIdentity(record.admission!.proposal),
    },
  };
}

/** Apply only to the original admitted proposal, never a temporary gate escalation copy. */
export function dotJudgmentApprovalRouteFields(
  charter: DotCharter,
  record: DotActionRecord
): Pick<RouteAutonomousDecisionInput, 'accountability' | 'scope'> {
  const expected = identity(charter, record);
  return expected ? { accountability: expected.accountability, scope: expected.scope } : {};
}

/** Body identity only; decision provenance is supplied by the existing governed store reader. */
export function dotJudgmentApprovalMatches(
  charter: DotCharter,
  record: DotActionRecord,
  approval: ApprovalRequestRecord | null
): boolean {
  try {
    const expected = identity(charter, record);
    if (!expected) return true;
    if (!approval) return false;
    judgmentCanonicalHash(approval);
    return (
      Boolean(record.request_id) &&
      approval.id === record.request_id &&
      approval.requestedBy === record.actor_id &&
      judgmentCanonicalHash(approval.source) === judgmentCanonicalHash(expected.source) &&
      judgmentCanonicalHash(approval.scope) === judgmentCanonicalHash(expected.scope) &&
      approval.accountability?.finalDecision === 'human_only' &&
      approval.accountability.payloadHash === expected.accountability.payloadHash &&
      approval.accountability.effectBinding === expected.accountability.effectBinding
    );
  } catch {
    return false;
  }
}

/** Preserve existing status vocabulary, expiry semantics, revocation and separation of duties. */
export function dotJudgmentApprovalFeedbackReady(
  charter: DotCharter,
  record: DotActionRecord,
  approval: ApprovalRequestRecord | null,
  now: number | (() => number)
): boolean {
  if (!dotJudgmentApprovalMatches(charter, record, approval)) return false;
  if (!record.semantic_judgment || !approval || !['approved', 'applied'].includes(approval.status))
    return true;
  const time = typeof now === 'function' ? now() : now;
  return (
    Number.isFinite(time) &&
    !isApprovalRequestExpired(approval, time) &&
    !approvalUsabilityRefusal(approval, 'dot_dispatch')
  );
}

/** Re-read immediately before creation/adoption; malformed or missing judged proof never upgrades. */
export function requireCurrentDotJudgmentApproval(
  charter: DotCharter,
  record: DotActionRecord,
  deps: Pick<DotDispatchDeps, 'loadApproval' | 'now'>
): ApprovalRequestRecord | undefined {
  if (!identity(charter, record)) return undefined;
  if (!record.request_id) {
    if ([record.decision, record.gate_decision, record.floor].includes('approve'))
      throw new Error('Judged human approval reference is missing');
    return undefined;
  }
  const approval = (
    deps.loadApproval ?? ((id) => loadApprovalRequest(AUTONOMY_APPROVAL_CHANNEL, id))
  )(record.request_id);
  if (
    !approval ||
    !['approved', 'applied'].includes(approval.status) ||
    !dotJudgmentApprovalFeedbackReady(
      charter,
      record,
      approval,
      (deps.now?.() ?? new Date()).getTime()
    )
  )
    throw new Error('Judged approval payload, effect or current usability differs');
  return approval;
}

/** Same legacy feedback DTO and idempotence key, without a second learning or approval store. */
export function recordDotApprovalFeedback(
  charter: DotCharter,
  row: DotActionRecord,
  approval: ApprovalRequestRecord | null,
  outcome: DotFeedbackOutcome,
  deps: DotFeedbackDeps
): void {
  if (hasDotFeedbackFor(charter.dot_id, row.action_ref, deps)) return;
  const decidedBy = approval?.decidedBy;
  recordDotFeedback(
    {
      dot_id: charter.dot_id,
      action_id: row.action_id,
      action_ref: row.action_ref,
      outcome,
      title: row.title,
      ...(decidedBy ? { decided_by: decidedBy } : {}),
      ...(approval?.decidedByType ? { decided_by_type: approval.decidedByType } : {}),
      ...(approval?.changeRequest
        ? { note: JSON.stringify(approval.changeRequest).slice(0, 300) }
        : {}),
    },
    deps
  );
}

/** Post-creation drift can suppress feedback, never roll back already committed internal work. */
export function recordDeferredDotJudgmentApprovalFeedback(
  charter: DotCharter,
  original: DotActionRecord,
  result: DotActionRecord,
  deps: DotDispatchDeps
): void {
  if (!original.semantic_judgment || !original.request_id || result.status !== 'dispatched') return;
  try {
    const before = identity(charter, original),
      after = identity(charter, result);
    if (
      !before ||
      !after ||
      original.request_id !== result.request_id ||
      judgmentCanonicalHash(before) !== judgmentCanonicalHash(after)
    )
      return;
    const approval = requireCurrentDotJudgmentApproval(charter, original, deps);
    if (approval)
      recordDotApprovalFeedback(charter, original, approval, 'approved', {
        rootDir: deps.rootDir,
        now: deps.now,
        ...(deps.feedback ?? {}),
      });
  } catch {
    /* No current approval evidence means no positive learning assertion. */
  }
}
