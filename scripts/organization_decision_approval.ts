import {
  computeApprovalPayloadHash,
  createApprovalRequest,
  loadApprovalRequest,
} from '@agent/core/governance/approval-store';
import type { OrganizationDecisionRecord } from '@agent/core/organization/organization-operating-model';

/** Storage channel for organization decision approval requests. */
export const DECISION_APPROVAL_CHANNEL = 'terminal';

function decisionEffect(decisionId: string, status: 'approved' | 'rejected'): string {
  return `organization:decision:${decisionId}:${status}`;
}

/** Binds an approval to the exact decision and the option a human is asked to approve. */
export function decisionApprovalPayloadHash(
  decision: Pick<OrganizationDecisionRecord, 'decision_id'>,
  chosenOption: string
): string {
  return computeApprovalPayloadHash({
    decision_id: decision.decision_id,
    chosen_option: chosenOption,
  });
}

/**
 * Opens the human approval request that `decision transition --record-status approved`
 * later verifies. The request names the proposed option; deciding it happens on a
 * strongly authenticated surface (surface session, TOTP or passkey).
 */
export function requestDecisionApproval(input: {
  decision: OrganizationDecisionRecord;
  chosenOption: string;
  requestedBy: string;
  rationale?: string;
}): { ref: string; request_id: string; effect: string } {
  const { decision, chosenOption } = input;
  if (!decision.options.includes(chosenOption)) {
    throw new Error(
      `--chosen-option '${chosenOption}' is not one of the decision options: ${decision.options.join(', ')}.`
    );
  }
  const effect = decisionEffect(decision.decision_id, 'approved');
  const record = createApprovalRequest('mission_controller', {
    channel: DECISION_APPROVAL_CHANNEL,
    threadTs: `organization-decision-${decision.decision_id}`,
    correlationId: `organization:${decision.organization_id}:decision:${decision.decision_id}`,
    requestedBy: input.requestedBy,
    kind: 'mission_gate',
    draft: {
      title: `Organization decision: ${decision.title}`,
      summary: `Approve option '${chosenOption}' for decision ${decision.decision_id} (${decision.organization_id}). Denying rejects the decision.`,
      details: [
        `Options: ${decision.options.join(', ')}`,
        `Proposed: ${chosenOption}`,
        ...(input.rationale ? [`Rationale: ${input.rationale}`] : []),
        ...(decision.due_at ? [`Due: ${decision.due_at}`] : []),
        'Decide on an authenticated surface (Chronos / concierge approvals); a CLI --approve is not accepted as decision evidence.',
      ].join('\n'),
      severity: 'medium',
    },
    requestedByContext: {
      surface: 'terminal',
      actorId: input.requestedBy,
      actorRole: 'organization_operator',
    },
    justification: {
      reason: `Organization decision ${decision.decision_id} needs a human approval before external action.`,
      impactSummary: `Records option '${chosenOption}' as the approved outcome.`,
      requestedEffects: [effect, decisionEffect(decision.decision_id, 'rejected')],
    },
    accountability: {
      finalDecision: 'human_only',
      payloadHash: decisionApprovalPayloadHash(decision, chosenOption),
      effectBinding: effect,
    },
    scope: {
      tier: decision.tier,
      tenant_slug: decision.tenant_slug,
      organization_id: decision.organization_id,
    },
  });
  return { ref: `${record.storageChannel}:${record.id}`, request_id: record.id, effect };
}

export function verifyDecisionApprovalRef(
  ref: string | undefined,
  decision: OrganizationDecisionRecord,
  status: 'approved' | 'rejected',
  chosenOption?: string
): string {
  const [channel, id, extra] = (ref || '').split(':');
  if (!channel || !id || extra) throw new Error('--approval-ref must be channel:id.');
  const approval = loadApprovalRequest(channel, id);
  const effect = decisionEffect(decision.decision_id, status);
  // A request opened by requestDecisionApproval binds the approve effect; a human
  // denying it is the rejection of the decision, so it settles `rejected` too.
  const bindings =
    status === 'rejected' ? [effect, decisionEffect(decision.decision_id, 'approved')] : [effect];
  const payloadHash = approval?.accountability?.payloadHash;
  if (
    !approval ||
    approval.status !== status ||
    approval.decidedByType !== 'human' ||
    approval.authenticated !== true ||
    !['surface_session', 'totp', 'passkey'].includes(approval.decidedAuthMethod || '') ||
    approval.accountability?.finalDecision !== 'human_only' ||
    !bindings.includes(approval.accountability.effectBinding || '') ||
    approval.scope?.organization_id !== decision.organization_id ||
    approval.scope?.tier !== decision.tier ||
    approval.scope?.tenant_slug !== decision.tenant_slug ||
    !approval.justification?.requestedEffects?.includes(effect)
  ) {
    throw new Error(
      'Approval reference does not contain an authenticated human decision bound to this organization decision.'
    );
  }
  if (
    status === 'approved' &&
    payloadHash &&
    payloadHash !== decisionApprovalPayloadHash(decision, chosenOption || '')
  ) {
    throw new Error(
      'The approval was given for a different option; pass the --chosen-option named in the approval request.'
    );
  }
  return ref!;
}
