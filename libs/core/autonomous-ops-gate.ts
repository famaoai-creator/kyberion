import { pathResolver } from './path-resolver.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { clamp } from './foundation/text.js';
import { assertSafeRepositoryPath } from './secure-io.js';
import { resolveIdentityContext } from './authority.js';

export type AutonomousOpsDecision = 'auto' | 'notify' | 'approve';
export type AutonomousOpsMode = 'apply' | 'dry_run';
export type AutonomousOpsAxisId = 'scope' | 'reversibility' | 'sensitivity' | 'confidence';

export interface AutonomousOpsActionPolicy {
  title: string;
  description: string;
  axis_scores: Record<AutonomousOpsAxisId, number>;
  budget_cap_tokens?: number;
}

export interface AutonomousOpsPolicy {
  version: string;
  decision_thresholds: {
    auto_max_score: number;
    notify_max_score: number;
  };
  axis_weights: Record<AutonomousOpsAxisId, number>;
  actions: Record<string, AutonomousOpsActionPolicy>;
  tenant_overrides?: Record<
    string,
    {
      actions?: Record<string, Partial<AutonomousOpsActionPolicy>>;
    }
  >;
}

export interface AutonomousOpsGateInput {
  actionId: string;
  tenantSlug?: string;
  executionMode?: AutonomousOpsMode;
  estimatedCostTokens?: number;
}

export interface AutonomousOpsGateResult {
  actionId: string;
  decision: AutonomousOpsDecision;
  allowed: boolean;
  score: number;
  maxScore: number;
  policyVersion: string;
  tenantSlug?: string;
  executionMode: AutonomousOpsMode;
  reason: string;
  axes: Record<AutonomousOpsAxisId, number>;
  budgetCapTokens?: number;
}

const DEFAULT_POLICY_PATH = pathResolver.knowledge('product/governance/autonomous-ops-policy.json');

function getPolicyPath(): string {
  return assertSafeRepositoryPath(
    getRegisteredEnvText('KYBERION_AUTONOMOUS_OPS_POLICY_PATH')?.trim() || DEFAULT_POLICY_PATH,
    { allowMissingLeaf: true }
  );
}

const autonomousOpsPolicyCatalog = defineCatalog<AutonomousOpsPolicy>({
  id: 'autonomous-ops-policy',
  path: getPolicyPath,
  schema: pathResolver.knowledge('product/schemas/autonomous-ops-policy.schema.json'),
});

export function _resetAutonomousOpsPolicyCacheForTests(): void {
  autonomousOpsPolicyCatalog.reset();
}

export function getAutonomousOpsPolicy(): AutonomousOpsPolicy {
  return autonomousOpsPolicyCatalog.load();
}

function clampAxisScore(score: number | undefined): number {
  if (!Number.isFinite(score ?? Number.NaN)) return 0;
  return clamp(Math.trunc(score ?? 0), 0, 3);
}

function mergeActionPolicy(
  base: AutonomousOpsActionPolicy | undefined,
  override: Partial<AutonomousOpsActionPolicy> | undefined
): AutonomousOpsActionPolicy | undefined {
  if (!base && !override) return undefined;
  const merged: AutonomousOpsActionPolicy = {
    title: override?.title ?? base?.title ?? '',
    description: override?.description ?? base?.description ?? '',
    axis_scores: {
      scope: clampAxisScore(override?.axis_scores?.scope ?? base?.axis_scores?.scope),
      reversibility: clampAxisScore(
        override?.axis_scores?.reversibility ?? base?.axis_scores?.reversibility
      ),
      sensitivity: clampAxisScore(
        override?.axis_scores?.sensitivity ?? base?.axis_scores?.sensitivity
      ),
      confidence: clampAxisScore(
        override?.axis_scores?.confidence ?? base?.axis_scores?.confidence
      ),
    },
    budget_cap_tokens: override?.budget_cap_tokens ?? base?.budget_cap_tokens,
  };
  return merged;
}

function resolveActionPolicy(
  policy: AutonomousOpsPolicy,
  actionId: string,
  tenantSlug?: string
): AutonomousOpsActionPolicy | undefined {
  const base = policy.actions[actionId];
  if (!tenantSlug) return base;
  const override = policy.tenant_overrides?.[tenantSlug]?.actions?.[actionId];
  return mergeActionPolicy(base, override);
}

function scoreAction(action: AutonomousOpsActionPolicy, policy: AutonomousOpsPolicy): number {
  return (Object.entries(policy.axis_weights) as Array<[AutonomousOpsAxisId, number]>).reduce(
    (total, [axis, weight]) => total + clampAxisScore(action.axis_scores[axis]) * weight,
    0
  );
}

function decisionFromScore(policy: AutonomousOpsPolicy, score: number): AutonomousOpsDecision {
  if (score <= policy.decision_thresholds.auto_max_score) return 'auto';
  if (score <= policy.decision_thresholds.notify_max_score) return 'notify';
  return 'approve';
}

export function evaluateAutonomousOpsAction(
  input: AutonomousOpsGateInput
): AutonomousOpsGateResult {
  const identity = resolveIdentityContext();
  const tenantSlug = input.tenantSlug ?? identity.tenantSlug;
  const executionMode = input.executionMode ?? 'apply';
  let policy: AutonomousOpsPolicy;
  try {
    policy = getAutonomousOpsPolicy();
  } catch {
    return {
      actionId: input.actionId,
      decision: 'approve',
      allowed: false,
      score: Number.POSITIVE_INFINITY,
      maxScore: 0,
      policyVersion: 'unavailable',
      tenantSlug,
      executionMode,
      reason: `Autonomous ops policy unavailable or invalid; refusing ${input.actionId}`,
      axes: { scope: 0, reversibility: 0, sensitivity: 0, confidence: 0 },
    };
  }

  const action = resolveActionPolicy(policy, input.actionId, tenantSlug);
  if (!action) {
    return {
      actionId: input.actionId,
      decision: 'approve',
      allowed: false,
      score: Number.POSITIVE_INFINITY,
      maxScore: policy.decision_thresholds.notify_max_score,
      policyVersion: policy.version,
      tenantSlug,
      executionMode,
      reason: `Unknown autonomous ops action: ${input.actionId}`,
      axes: { scope: 0, reversibility: 0, sensitivity: 0, confidence: 0 },
    };
  }

  const score = scoreAction(action, policy);
  const maxScore = policy.decision_thresholds.notify_max_score;
  let decision = executionMode === 'dry_run' ? 'auto' : decisionFromScore(policy, score);
  let reason = `autonomous ops score ${score}/${maxScore} for ${input.actionId}`;

  if (
    executionMode !== 'dry_run' &&
    typeof input.estimatedCostTokens === 'number' &&
    Number.isFinite(input.estimatedCostTokens)
  ) {
    const budgetCapTokens = action.budget_cap_tokens;
    if (typeof budgetCapTokens === 'number' && input.estimatedCostTokens > budgetCapTokens) {
      decision = 'approve';
      reason = `Estimated cost ${input.estimatedCostTokens} exceeds budget cap ${budgetCapTokens}`;
    }
  }

  return {
    actionId: input.actionId,
    decision,
    allowed: decision !== 'approve',
    score,
    maxScore,
    policyVersion: policy.version,
    tenantSlug,
    executionMode,
    reason,
    axes: { ...action.axis_scores },
    budgetCapTokens: action.budget_cap_tokens,
  };
}
