/**
 * Accountability-charter branch of the approval gate.
 *
 * A trusted caller opts in by passing `charter` (scope + the action's facts —
 * amount, reversibility, who acts for whom). Never derived from the untrusted
 * `payload`. With no charter for the scope this is a no-op and the legacy gate
 * runs unchanged.
 *
 * The charter only ever AUTO-ALLOWS work that is inside the accountable
 * human's declared envelope. It never removes a gate that exists for a reason
 * outside the envelope's vocabulary: hardened policies (injection suspected,
 * strict posture, dual-key, hard-coded dangerous shell/egress/secret/deploy)
 * still go to a human. And it only ever TIGHTENS on the way out: an action
 * outside the envelope requires human approval even when the legacy policy
 * would have let it through.
 */

import { auditChain } from './audit-chain.js';
import { recordGovernanceAction } from './governance-action-recorder.js';
import { notifyOperator } from '../surface/operator-notifications.js';
import { resolveApprovalPolicy, type ApprovalPolicyResolution } from './approval-policy.js';
import {
  delegatedDecisionPolicy,
  type CharterAction,
  type CharterAvailability,
  type CharterScope,
} from './accountability-charter.js';
import {
  evaluateUnderCharter,
  recordCharterConsumption,
  recordCharterDenial,
  type CharterPathOptions,
} from './accountability-charter-registry.js';

export interface ApprovalGateCharterInput {
  scope: CharterScope;
  action: CharterAction;
  /** Defaults to "the accountable human is available". */
  availability?: CharterAvailability;
  pathOptions?: CharterPathOptions;
}

export type CharterGateOutcome =
  | { kind: 'none' }
  | { kind: 'stop'; message: string }
  | { kind: 'allow'; message: string }
  | { kind: 'require_approval'; reason: string };

const HARDENED_RULES = new Set(['injection-suspected-override', 'strict-posture-floor']);

/** Policies whose reason for a human lies outside what an envelope can express. */
export function isCharterEligiblePolicy(policy: ApprovalPolicyResolution): boolean {
  if (policy.mandatoryApproval) return false;
  const rule = policy.matchedRuleId;
  if (rule && (HARDENED_RULES.has(rule) || rule.startsWith('fallback-dangerous-'))) return false;
  return !policy.missingRequirements.includes('dual_key_confirmation');
}

export function runCharterGate(input: {
  charter: ApprovalGateCharterInput;
  agentId: string;
  operationId: string;
  intentId?: string;
  correlationId: string;
  payload?: Record<string, unknown>;
  /** The decision-rights matrix routes this decision to a human. */
  decisionRightsEscalates?: boolean;
  /**
   * The matrix escalates only because a human accepts this type, and the
   * organization marked the type `charter_delegable`.
   */
  decisionRightsCharterDelegable?: boolean;
  now?: Date;
}): CharterGateOutcome {
  const { charter, agentId, operationId, correlationId } = input;
  const now = input.now ?? new Date();
  const evaluated = evaluateUnderCharter(
    charter.scope,
    charter.action,
    charter.availability ?? { accountable_available: true, available_deputies: [] },
    charter.pathOptions,
    now
  );
  if (!evaluated) return { kind: 'none' };
  const { charter: active, decision } = evaluated;
  const metadata = {
    correlationId,
    intentId: input.intentId,
    charter_id: active.charter_id,
    responsible: decision.responsible,
    on_behalf_of: charter.action.actor.on_behalf_of,
    decision: decision.decision,
  };

  if (decision.decision === 'stop') {
    const reason = `[CHARTER_STOP] ${decision.reasons.join(', ')} — only the accountable human can clear this`;
    auditChain.record({
      agentId,
      action: 'approval_gate',
      operation: operationId,
      result: 'denied',
      reason,
      metadata,
    });
    recordGovernanceAction(agentId, 'approval_gate', `${operationId}:denied`, true);
    return { kind: 'stop', message: reason };
  }

  if (decision.decision === 'allow' || decision.decision === 'allow_notify') {
    const policy = resolveApprovalPolicy({ intentId: input.intentId, payload: input.payload });
    if (!isCharterEligiblePolicy(policy)) {
      return {
        kind: 'require_approval',
        reason: `hardened policy '${policy.matchedRuleId ?? 'dual_key_confirmation'}' is outside what a charter can delegate`,
      };
    }
    // The matrix is organizational governance: a charter stands in for it only
    // when the accountable human explicitly, and with authority, said so — for
    // every decision (supersedes) or for a type the organization made
    // delegable and the charter named (the evaluation already checked the name).
    const namedDelegableType =
      input.decisionRightsCharterDelegable === true &&
      Boolean(charter.action.decision_type) &&
      delegatedDecisionPolicy(active.envelope, charter.action.decision_type!) !== 'forbid';
    if (
      input.decisionRightsEscalates &&
      active.envelope.supersedes_decision_rights !== true &&
      !namedDelegableType
    ) {
      return {
        kind: 'require_approval',
        reason: `decision-rights matrix escalates this decision and charter ${active.charter_id} does not supersede it`,
      };
    }
    recordCharterConsumption(
      active,
      charter.action,
      decision,
      charter.pathOptions,
      now,
      correlationId
    );
    const message = `Within accountability charter ${active.charter_id} (responsible: ${decision.responsible})`;
    auditChain.record({
      agentId,
      action: 'approval_gate',
      operation: operationId,
      result: 'allowed',
      reason: message,
      metadata: { ...metadata, consumption: decision.consumption },
    });
    recordGovernanceAction(agentId, 'approval_gate', `${operationId}:allowed`, false);
    if (decision.decision === 'allow_notify') {
      void notifyOperator('decision_digest', {
        title: `Charter budget near its limit (${active.charter_id})`,
        body: `${operationId} ran inside the charter; a budget is above 80%.`,
        correlation_id: `charter-near-limit:${active.charter_id}:${now.toISOString().slice(0, 10)}`,
      });
    }
    return { kind: 'allow', message };
  }

  // deny: outside the envelope / appetite. A human decides this one action.
  recordCharterDenial(active, charter.action, decision, charter.pathOptions, now, correlationId);
  auditChain.record({
    agentId,
    action: 'approval_gate',
    operation: operationId,
    result: 'denied',
    reason: `Outside accountability charter ${active.charter_id}: ${decision.reasons.join(', ')}`,
    metadata: { ...metadata, amendment: decision.amendment },
  });
  return { kind: 'require_approval', reason: decision.reasons.join(', ') };
}
