import { defineCatalog } from '../foundation/governed-catalog.js';
import { pathResolver } from '../path-resolver.js';
import {
  getAutonomousOpsPolicy,
  type AutonomousOpsGateResult,
} from '../governance/autonomous-ops-gate.js';
import type { DotDecisionLevel, DotExecutionShape, DotProposal } from './dot-proposals.js';
import type { DotCharter } from './dot-charter.js';
import {
  DOT_L4_NOTIFY_TO_AUTO_EXCEPTION,
  DOT_SEMANTIC_APPROVE_TO_NOTIFY_EXCEPTION,
} from './dot-extensions.js';

export interface DotExecutionPolicy {
  version: string;
  intake: {
    enabled: boolean;
    action_id: string;
    allowed_execution_shapes: DotExecutionShape[];
    max_proposals_per_wake: number;
  };
  learning: {
    enabled: boolean;
    l2_release_approvals: number;
    l3_release_approvals: number;
    l3_decay_days: number;
    metrics_days: number;
  };
}

const fallback: DotExecutionPolicy = {
  version: 'disabled',
  intake: {
    enabled: false,
    action_id: 'dot_intake_work',
    allowed_execution_shapes: [],
    max_proposals_per_wake: 1,
  },
  learning: {
    enabled: false,
    // Disabled independently of thresholds; keep the conservative defaults
    // inside the same schema bounds required of file-loaded policies.
    l2_release_approvals: 1000000,
    l3_release_approvals: 1000000,
    l3_decay_days: 36500,
    metrics_days: 30,
  },
};
const catalog = defineCatalog<DotExecutionPolicy>({
  id: 'dot-execution-policy',
  path: () => pathResolver.knowledge('product/governance/dot-execution-policy.json'),
  schema: pathResolver.knowledge('product/schemas/dot-execution-policy.schema.json'),
  fallback,
  fallbackOnInvalid: true,
});
export function loadDotExecutionPolicy(): DotExecutionPolicy {
  try {
    return catalog.load();
  } catch {
    return structuredClone(fallback);
  }
}

/** This classifies the effect of ADMISSION, never the work described in prose. */
export function isDotIntakeAdmission(charter: DotCharter, proposal: DotProposal): boolean {
  const policy = loadDotExecutionPolicy().intake;
  return (
    policy.enabled &&
    charter.status === 'active' &&
    Boolean(charter.scope.tenant_slug) &&
    !proposal.continuous_work &&
    !proposal.front_desk_execution &&
    policy.allowed_execution_shapes.includes(proposal.execution_shape)
  );
}

const DECISION_RANK: Record<DotDecisionLevel, number> = { auto: 0, notify: 1, approve: 2 };
const DOT_NON_RELAXABLE_ESCALATIONS = new Set([
  'never_auto',
  'high_risk_path',
  'axis_max',
  'budget',
]);

function policyRelaxationPreconditionsHold(input: {
  proposal: Pick<DotProposal, 'action_id'>;
  policyGate: AutonomousOpsGateResult;
  expectedPolicyDecision: 'notify' | 'approve';
  hardFloor: DotDecisionLevel | undefined;
  relaxableActions: readonly string[];
}): boolean {
  const { proposal, policyGate, expectedPolicyDecision, hardFloor } = input;
  if (!input.relaxableActions.includes(proposal.action_id)) return false;
  if (policyGate.decision !== expectedPolicyDecision || policyGate.shadow) return false;
  if (hardFloor && DECISION_RANK[hardFloor] >= DECISION_RANK[expectedPolicyDecision]) return false;
  if ((policyGate.escalations ?? []).some((rule) => DOT_NON_RELAXABLE_ESCALATIONS.has(rule))) {
    return false;
  }
  if ((policyGate.highRiskPathMatches ?? []).length > 0) return false;
  return (policyGate.axes?.reversibility ?? 3) < 2;
}

/**
 * Policy-side re-verification for DL-10 L4 `notify -> auto` relaxation.
 */
export function dotNotifyToAutoExceptionApplies(input: {
  proposal: Pick<DotProposal, 'action_id'>;
  relaxed: { decision: DotDecisionLevel; exception?: string };
  policyGate: AutonomousOpsGateResult;
  hardFloor: DotDecisionLevel | undefined;
  relaxableActions: readonly string[];
}): boolean {
  if (
    input.relaxed.exception !== DOT_L4_NOTIFY_TO_AUTO_EXCEPTION ||
    input.relaxed.decision !== 'auto'
  ) {
    return false;
  }
  return policyRelaxationPreconditionsHold({ ...input, expectedPolicyDecision: 'notify' });
}

/**
 * Policy-side re-verification for evidence-backed semantic `approve -> notify`
 * relaxation in `advisory` mode.
 */
export function dotSemanticApproveToNotifyExceptionApplies(input: {
  charter: Pick<DotCharter, 'runtime'>;
  proposal: Pick<DotProposal, 'action_id'>;
  relaxed: { decision: DotDecisionLevel; exception?: string };
  policyGate: AutonomousOpsGateResult;
  hardFloor: DotDecisionLevel | undefined;
  relaxableActions: readonly string[];
}): boolean {
  if (input.charter.runtime.semantic_judgment?.mode !== 'advisory') return false;
  if (
    input.relaxed.exception !== DOT_SEMANTIC_APPROVE_TO_NOTIFY_EXCEPTION ||
    input.relaxed.decision !== 'notify'
  ) {
    return false;
  }
  return policyRelaxationPreconditionsHold({ ...input, expectedPolicyDecision: 'approve' });
}

/** Policy `autonomy.relaxable_actions` (fail-closed empty when unreadable). */
export function policyRelaxableActions(): readonly string[] {
  try {
    const autonomy = (getAutonomousOpsPolicy() as { autonomy?: { relaxable_actions?: unknown } })
      .autonomy;
    const list = autonomy?.relaxable_actions;
    return Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** Resolve either named policy exception (`l4_notify_to_auto` or `semantic_approve_to_notify`). */
export function resolveNamedDotGateRelaxation(input: {
  charter: Pick<DotCharter, 'runtime'>;
  proposal: Pick<DotProposal, 'action_id'>;
  relaxerId: string;
  relaxed: { decision: DotDecisionLevel; reason: string; exception?: string };
  policyGate: AutonomousOpsGateResult;
  hardFloor: DotDecisionLevel | undefined;
  relaxableActions: readonly string[];
}): { floor: DotDecisionLevel; gate: AutonomousOpsGateResult } | undefined {
  const { charter, proposal, relaxerId, relaxed, policyGate, hardFloor, relaxableActions } = input;
  if (
    dotNotifyToAutoExceptionApplies({ proposal, relaxed, policyGate, hardFloor, relaxableActions })
  ) {
    return {
      floor: 'auto',
      gate: {
        ...policyGate,
        decision: 'auto',
        allowed: true,
        vetoWindowMinutes: undefined,
        reason: `${policyGate.reason}; ${DOT_L4_NOTIFY_TO_AUTO_EXCEPTION} by ${relaxerId}: ${relaxed.reason}`,
      },
    };
  }
  if (
    dotSemanticApproveToNotifyExceptionApplies({
      charter,
      proposal,
      relaxed,
      policyGate,
      hardFloor,
      relaxableActions,
    })
  ) {
    return {
      floor: 'notify',
      gate: {
        ...policyGate,
        decision: 'notify',
        allowed: true,
        reason: `${policyGate.reason}; ${DOT_SEMANTIC_APPROVE_TO_NOTIFY_EXCEPTION} by ${relaxerId}: ${relaxed.reason}`,
      },
    };
  }
  return undefined;
}
