/**
 * The human-only final-decision contract (`accountability.finalDecision:
 * 'human_only'`), shared by the approval store and the consumers that re-check
 * a decision before applying it.
 */
import type { ApprovalAccountability, ApprovalRecord } from './approval-store.js';
import { auditChain } from './audit-chain.js';
import { notifyOperator } from '../surface/operator-notifications.js';
import {
  assuranceMeets,
  assuranceOfAuthMethod,
  DEFAULT_HUMAN_ONLY_MIN_ASSURANCE,
  isApprovalAssuranceLevel,
  NON_HUMAN_PROOF_AUTH_METHODS,
  resolveApprovalAssuranceMode,
  type ApprovalAssuranceMode,
  type ApprovalAssuranceShortfall,
} from './approval-assurance.js';

/**
 * HA-02: agent-facing decision paths (MCP `kyberion.approval.decide`, the
 * approval-actuator `decide` op) cannot prove a human decider, so they never
 * settle a human-only request — approve or reject — in any rollout mode.
 */
export function refuseHumanOnlyDecisionOnAgentPath(
  record: { id: string; accountability?: ApprovalAccountability },
  path: string
): void {
  if (record.accountability?.finalDecision !== 'human_only') return;
  throw new Error(
    `[APPROVAL_HUMAN_PROOF_REQUIRED] ${path} cannot decide human-only approval ${record.id} — an agent-facing path cannot prove a human decider ` +
      '| next: decide it on Concierge, Chronos or presence-studio, or from your own terminal outside the agent session ' +
      `| evidence: accountability.finalDecision=human_only on ${record.id}`
  );
}

/**
 * Throws when the decision cannot settle a human-only request. Returns the
 * assurance shortfall a `warn`-mode decision is let through with, so the
 * caller can record it; undefined when there is none.
 *
 * `phase: 'recheck'` is for consumers re-validating an already-decided
 * record: the assurance level was judged when the decision was recorded and
 * is not re-judged (decided records are not retroactively re-graded), while
 * every other rule still applies.
 */
export function validateHumanFinalDecision(params: {
  accountability?: ApprovalAccountability;
  decidedByType?: ApprovalRecord['decidedByType'];
  authenticated?: boolean;
  authMethod?: ApprovalRecord['authMethod'];
  payloadHash?: string;
  effectBinding?: string;
  phase?: 'decision' | 'recheck';
  mode?: ApprovalAssuranceMode;
}): ApprovalAssuranceShortfall | undefined {
  if (params.accountability?.finalDecision !== 'human_only') return undefined;
  if (params.decidedByType !== 'human') {
    throw new Error('[POLICY_VIOLATION] Final approval requires a human decider');
  }
  if (params.authenticated !== true) {
    throw new Error('[POLICY_VIOLATION] Final approval requires an authenticated human decider');
  }
  if (params.authMethod && NON_HUMAN_PROOF_AUTH_METHODS.has(params.authMethod)) {
    throw new Error(
      `[POLICY_VIOLATION] Final approval requires a human-authenticated surface; ${params.authMethod} is not sufficient`
    );
  }
  let shortfall: ApprovalAssuranceShortfall | undefined;
  if (params.phase !== 'recheck') {
    const provided = assuranceOfAuthMethod(params.authMethod);
    if (!params.authMethod || !provided) {
      throw new Error(
        `[POLICY_VIOLATION] Final approval requires a recognised authMethod (got ${params.authMethod ?? 'none'})`
      );
    }
    const required = params.accountability.min_assurance ?? DEFAULT_HUMAN_ONLY_MIN_ASSURANCE;
    if (!assuranceMeets(provided, required)) {
      const mode = params.mode ?? resolveApprovalAssuranceMode();
      if (mode === 'enforce') {
        throw new Error(
          `[POLICY_VIOLATION] Final approval requires assurance ${required}; ${params.authMethod} provides ${provided}`
        );
      }
      shortfall = { required, provided, authMethod: params.authMethod, mode };
    }
  }
  if (
    params.accountability.payloadHash &&
    params.payloadHash !== params.accountability.payloadHash
  ) {
    throw new Error('[POLICY_VIOLATION] Approval payload hash does not match the requested effect');
  }
  if (
    params.accountability.effectBinding &&
    params.effectBinding !== params.accountability.effectBinding
  ) {
    throw new Error(
      '[POLICY_VIOLATION] Approval effect binding does not match the requested operation'
    );
  }
  return shortfall;
}

export function withDefaultMinAssurance(
  accountability: ApprovalAccountability | undefined
): ApprovalAccountability | undefined {
  if (!accountability) return accountability;
  if (accountability.min_assurance === undefined) {
    return { ...accountability, min_assurance: DEFAULT_HUMAN_ONLY_MIN_ASSURANCE };
  }
  if (!isApprovalAssuranceLevel(accountability.min_assurance)) {
    throw new Error(
      `[POLICY_VIOLATION] Invalid approval min_assurance: ${String(accountability.min_assurance)}`
    );
  }
  // A requester may raise the bar for a human-only decision, never lower it.
  if (
    accountability.finalDecision === 'human_only' &&
    !assuranceMeets(accountability.min_assurance, DEFAULT_HUMAN_ONLY_MIN_ASSURANCE)
  ) {
    return { ...accountability, min_assurance: DEFAULT_HUMAN_ONLY_MIN_ASSURANCE };
  }
  return accountability;
}

/**
 * HA-03 warn rollout: a below-assurance human-only decision is let through,
 * but it must leave an audit trail and reach the operator (rate-limited per
 * auth method and level, so a surface that always falls short does not page
 * on every decision).
 */
export function reportAssuranceShortfall(
  record: { id: string; channel: string; correlationId?: string },
  shortfall: ApprovalAssuranceShortfall,
  decidedBy: string
): void {
  auditChain.record({
    agentId: decidedBy,
    action: 'approval_decision',
    operation: 'assurance_shortfall',
    result: 'allowed',
    reason: `human-only decision accepted below min_assurance ${shortfall.required} (${shortfall.authMethod} provides ${shortfall.provided}) — KYBERION_APPROVAL_ASSURANCE=${shortfall.mode}`,
    correlationId: record.correlationId,
    metadata: {
      requestId: record.id,
      channel: record.channel,
      required: shortfall.required,
      provided: shortfall.provided,
      authMethod: shortfall.authMethod,
      mode: shortfall.mode,
    },
  });
  void notifyOperator('ops_alert', {
    title: `Approval assurance shortfall (${shortfall.authMethod})`,
    body:
      `A human-only approval was accepted with ${shortfall.authMethod} (${shortfall.provided}) ` +
      `below the required ${shortfall.required}. It will be rejected once ` +
      'KYBERION_APPROVAL_ASSURANCE=enforce. Next: decide human-only requests on a surface ' +
      `that provides ${shortfall.required} before enabling enforce.`,
    correlation_id: `approval-assurance-shortfall:${shortfall.authMethod}:${shortfall.required}`,
  });
}
