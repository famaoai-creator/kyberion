import {
  buildVetoWindow,
  evaluateVetoWindow,
  type ApprovalVetoWindow,
  type VetoWindowState,
} from './approval-veto-window.js';
import {
  evaluateAutonomousOpsAction,
  getAutonomousOpsPolicy,
  type AutonomousOpsDecision,
  type AutonomousOpsPolicy,
} from './autonomous-ops-gate.js';
import {
  evaluateDiffAgainstFactoryEnvelope,
  type FactoryDeliveryEnvelope,
  type FactoryMergeMode,
} from './factory-delivery-envelope.js';
import type { FactoryAutonomyPolicy } from './factory-policy.js';
import { isOperationsHalted } from './operations-halt.js';
import { classifyPullRequest, type PrFile, type PrRiskTier } from './pr-shadow.js';

export type FactoryMergeAction =
  'auto_merge' | 'open_veto_window' | 'wait_veto_window' | 'escalate_human';

export type FactoryMergeActionId = 'pr_merge_low' | 'pr_merge_medium' | 'pr_merge_high';

export interface FactoryMergeGateInput {
  envelope: FactoryDeliveryEnvelope;
  changed_paths: readonly string[];
  files?: readonly PrFile[];
  ci_green: boolean;
  cross_provider_review_verified: boolean;
  repairs_used: number;
  max_repairs?: number;
  detected_classes?: readonly string[];
  veto_window?: ApprovalVetoWindow;
  veto_objected?: boolean;
  now?: Date | number;
  tenant_slug?: string;
  policy?: AutonomousOpsPolicy;
  factory_policy?: FactoryAutonomyPolicy;
  operations_halted?: boolean;
}

export interface FactoryMergeGateResult {
  action: FactoryMergeAction;
  allowed: boolean;
  tier: PrRiskTier;
  action_id: FactoryMergeActionId;
  effective_merge_mode: FactoryMergeMode;
  reason: string;
  reasons: string[];
  escalations: string[];
  high_risk_matches: string[];
  envelope_ok: boolean;
  gate_decision: AutonomousOpsDecision;
  gate_shadow: boolean;
  veto_window?: ApprovalVetoWindow;
  veto_state?: VetoWindowState;
}

const DEFAULT_MEDIUM_VETO_MINUTES = 120;

function safeActiveHours(
  explicitPolicy: AutonomousOpsPolicy | undefined
): AutonomousOpsPolicy['active_hours'] {
  try {
    return (explicitPolicy ?? getAutonomousOpsPolicy()).active_hours;
  } catch {
    return undefined;
  }
}

/**
 * Evaluate risk-tiered merge eligibility for a Factory delivery PR:
 * - enforces halt switch, immutable envelope bounds, CI/review evidence, and repair cap
 * - tightens (never loosens) merge mode according to envelope constraints
 * - allows immediate auto-merge for graduated low-risk diffs, 120m veto windows for medium risk,
 *   and always escalates high-risk or shadow/fail-closed cases to human approval.
 */
export function evaluateFactoryMergeGate(input: FactoryMergeGateInput): FactoryMergeGateResult {
  const nowMs = typeof input.now === 'number' ? input.now : (input.now?.getTime() ?? Date.now());
  const tenantSlug = input.tenant_slug ?? input.envelope.tenant_slug;
  const changedPaths = [...input.changed_paths];
  const prFiles: PrFile[] = input.files
    ? [...input.files]
    : changedPaths.map((p) => ({ path: p, additions: 0, deletions: 0 }));

  const escalate = (params: {
    tier?: PrRiskTier;
    action_id?: FactoryMergeActionId;
    effective_merge_mode?: FactoryMergeMode;
    reason: string;
    reasons?: string[];
    escalations?: string[];
    high_risk_matches?: string[];
    envelope_ok: boolean;
    gate_decision?: AutonomousOpsDecision;
    gate_shadow?: boolean;
    veto_window?: ApprovalVetoWindow;
    veto_state?: VetoWindowState;
  }): FactoryMergeGateResult => ({
    action: 'escalate_human',
    allowed: false,
    tier: params.tier ?? 'high',
    action_id: params.action_id ?? 'pr_merge_high',
    effective_merge_mode: params.effective_merge_mode ?? 'human_only',
    reason: params.reason,
    reasons: params.reasons ?? [params.reason],
    escalations: params.escalations ?? [],
    high_risk_matches: params.high_risk_matches ?? [],
    envelope_ok: params.envelope_ok,
    gate_decision: params.gate_decision ?? 'approve',
    gate_shadow: params.gate_shadow ?? false,
    ...(params.veto_window ? { veto_window: params.veto_window } : {}),
    ...(params.veto_state ? { veto_state: params.veto_state } : {}),
  });

  if ((input.operations_halted ?? isOperationsHalted()) === true) {
    return escalate({
      reason: 'Operations are halted; factory merge requires explicit human approval',
      escalations: ['operations_halted'],
      envelope_ok: false,
    });
  }

  const envelopeCheck = evaluateDiffAgainstFactoryEnvelope({
    envelope: input.envelope,
    changed_paths: changedPaths,
    policy: input.policy,
  });
  if (!envelopeCheck.ok) {
    const reasons = envelopeCheck.violations.map((v) => v.detail);
    return escalate({
      reason: reasons.join('; ') || 'Factory delivery envelope check failed',
      reasons,
      escalations: envelopeCheck.violations.map((v) => v.code),
      high_risk_matches: envelopeCheck.high_risk_matches,
      envelope_ok: false,
    });
  }

  const missingEvidence: string[] = [];
  if (!input.ci_green) missingEvidence.push('ci_green');
  if (!input.cross_provider_review_verified) missingEvidence.push('cross_provider_review');
  if (missingEvidence.length > 0) {
    const reason = `Required merge evidence missing: ${missingEvidence.join(', ')}`;
    return escalate({
      reason,
      escalations: missingEvidence,
      envelope_ok: true,
    });
  }

  const effectiveMaxRepairs =
    input.max_repairs !== undefined
      ? Math.min(input.envelope.max_ci_repair_attempts, input.max_repairs)
      : input.envelope.max_ci_repair_attempts;
  if (input.repairs_used > 0 && input.repairs_used >= effectiveMaxRepairs) {
    return escalate({
      reason: `Development self-repair cap reached (${input.repairs_used}/${effectiveMaxRepairs}); human review required`,
      escalations: ['repair_cap_reached'],
      envelope_ok: true,
    });
  }

  const classification = classifyPullRequest(prFiles);
  let tier: PrRiskTier;
  let actionId: FactoryMergeActionId;
  if (envelopeCheck.recommended_merge_mode === 'human_only' || classification.tier === 'high') {
    tier = 'high';
    actionId = 'pr_merge_high';
  } else if (
    classification.tier === 'low' &&
    envelopeCheck.recommended_merge_mode === 'auto_low_risk'
  ) {
    tier = 'low';
    actionId = 'pr_merge_low';
  } else {
    tier = 'medium';
    actionId = 'pr_merge_medium';
  }

  const gate = evaluateAutonomousOpsAction({
    actionId,
    tenantSlug,
    changedPaths,
    detectedClasses: input.detected_classes ? [...input.detected_classes] : undefined,
    factoryPolicy: input.factory_policy,
  });

  if (
    tier === 'high' ||
    gate.decision === 'approve' ||
    gate.highRiskPathMatches.length > 0 ||
    gate.escalations.includes('never_auto')
  ) {
    return escalate({
      tier: 'high',
      action_id: 'pr_merge_high',
      effective_merge_mode: 'human_only',
      reason: gate.reason || 'High-risk merge requires human approval',
      escalations: gate.escalations,
      high_risk_matches: gate.highRiskPathMatches,
      envelope_ok: true,
      gate_decision: gate.decision,
      gate_shadow: gate.shadow,
    });
  }

  const candidateMergeMode: FactoryMergeMode =
    tier === 'low' && gate.decision === 'auto' ? 'auto_low_risk' : 'veto_window';

  if (gate.shadow || !gate.allowed) {
    return escalate({
      tier,
      action_id: actionId,
      effective_merge_mode: candidateMergeMode,
      reason: gate.shadow
        ? `${actionId} remains in shadow mode${tenantSlug ? ` for tenant ${tenantSlug}` : ''}; human approval required`
        : gate.reason || `${actionId} was denied by autonomous ops gate`,
      escalations: gate.shadow ? ['shadow_mode', ...gate.escalations] : gate.escalations,
      high_risk_matches: gate.highRiskPathMatches,
      envelope_ok: true,
      gate_decision: gate.decision,
      gate_shadow: gate.shadow,
    });
  }

  if (tier === 'low' && actionId === 'pr_merge_low' && gate.decision === 'auto') {
    return {
      action: 'auto_merge',
      allowed: true,
      tier: 'low',
      action_id: 'pr_merge_low',
      effective_merge_mode: 'auto_low_risk',
      reason: 'Low-risk factory PR satisfied envelope, CI, review, and graduated auto-merge gate',
      reasons: [gate.reason],
      escalations: gate.escalations,
      high_risk_matches: gate.highRiskPathMatches,
      envelope_ok: true,
      gate_decision: gate.decision,
      gate_shadow: false,
    };
  }

  if (input.veto_objected === true) {
    return escalate({
      tier,
      action_id: actionId,
      effective_merge_mode: 'veto_window',
      reason: 'Operator objected during veto window',
      escalations: ['veto_objected'],
      high_risk_matches: gate.highRiskPathMatches,
      envelope_ok: true,
      gate_decision: gate.decision,
      gate_shadow: gate.shadow,
      veto_window: input.veto_window,
    });
  }

  if (!input.veto_window) {
    const windowMinutes = gate.vetoWindowMinutes ?? DEFAULT_MEDIUM_VETO_MINUTES;
    const created = buildVetoWindow({
      windowMinutes,
      activeHours: safeActiveHours(input.policy),
      shadow: gate.shadow,
      now: nowMs,
    });
    return {
      action: 'open_veto_window',
      allowed: false,
      tier,
      action_id: actionId,
      effective_merge_mode: 'veto_window',
      reason: `Opened ${windowMinutes}-minute veto window awaiting surface delivery receipt`,
      reasons: [gate.reason],
      escalations: gate.escalations,
      high_risk_matches: gate.highRiskPathMatches,
      envelope_ok: true,
      gate_decision: gate.decision,
      gate_shadow: gate.shadow,
      veto_window: created,
      veto_state: 'awaiting_delivery',
    };
  }

  const vetoState = evaluateVetoWindow(input.veto_window, nowMs);
  if (vetoState === 'awaiting_delivery' || vetoState === 'counting') {
    return {
      action: 'wait_veto_window',
      allowed: false,
      tier,
      action_id: actionId,
      effective_merge_mode: 'veto_window',
      reason:
        vetoState === 'awaiting_delivery'
          ? 'Waiting for surface delivery confirmation before starting veto countdown'
          : `Waiting for veto window countdown to elapse (proceedsAt: ${input.veto_window.proceedsAt ?? 'unknown'})`,
      reasons: [gate.reason],
      escalations: gate.escalations,
      high_risk_matches: gate.highRiskPathMatches,
      envelope_ok: true,
      gate_decision: gate.decision,
      gate_shadow: gate.shadow,
      veto_window: input.veto_window,
      veto_state: vetoState,
    };
  }

  if (vetoState === 'undelivered' || vetoState === 'elapsed_shadow') {
    return escalate({
      tier,
      action_id: actionId,
      effective_merge_mode: 'veto_window',
      reason:
        vetoState === 'undelivered'
          ? 'Veto notification was not delivered within grace window; falling back fail-closed to human approval'
          : 'Shadow veto window elapsed; recorded only, falling back fail-closed to human approval',
      escalations: [vetoState, ...gate.escalations],
      high_risk_matches: gate.highRiskPathMatches,
      envelope_ok: true,
      gate_decision: gate.decision,
      gate_shadow: gate.shadow,
      veto_window: input.veto_window,
      veto_state: vetoState,
    });
  }

  return {
    action: 'auto_merge',
    allowed: true,
    tier,
    action_id: actionId,
    effective_merge_mode: 'veto_window',
    reason:
      'Veto window elapsed without operator objection; medium-risk factory PR cleared for merge',
    reasons: [gate.reason],
    escalations: gate.escalations,
    high_risk_matches: gate.highRiskPathMatches,
    envelope_ok: true,
    gate_decision: gate.decision,
    gate_shadow: false,
    veto_window: input.veto_window,
    veto_state: 'elapsed',
  };
}
