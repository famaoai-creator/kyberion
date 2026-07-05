import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeStat } from './secure-io.js';
import { safeJsonParse } from './validators.js';
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

const FALLBACK_POLICY: AutonomousOpsPolicy = {
  version: 'fallback',
  decision_thresholds: {
    auto_max_score: 3,
    notify_max_score: 6,
  },
  axis_weights: {
    scope: 1,
    reversibility: 1,
    sensitivity: 1,
    confidence: 1,
  },
  actions: {
    storage_janitor: {
      title: 'Storage janitor',
      description: 'Remove stale runtime and temporary artifacts after safe verification.',
      axis_scores: { scope: 2, reversibility: 2, sensitivity: 1, confidence: 2 },
      budget_cap_tokens: 2000,
    },
    baseline_health_scan: {
      title: 'Baseline health scan',
      description: 'Run the baseline health and maintenance readiness scan.',
      axis_scores: { scope: 0, reversibility: 0, sensitivity: 0, confidence: 1 },
      budget_cap_tokens: 1000,
    },
    tenant_drift_watch: {
      title: 'Tenant drift watch',
      description: 'Observe tenant drift and surface drift signals.',
      axis_scores: { scope: 1, reversibility: 0, sensitivity: 1, confidence: 2 },
      budget_cap_tokens: 1500,
    },
    dependency_vuln_scan: {
      title: 'Dependency vulnerability scan',
      description: 'Scan dependency vulnerabilities and append to the ledger.',
      axis_scores: { scope: 1, reversibility: 0, sensitivity: 1, confidence: 1 },
      budget_cap_tokens: 4000,
    },
    auto_checkpoint: {
      title: 'Automatic checkpoint',
      description: 'Persist a durable checkpoint for long-running maintenance.',
      axis_scores: { scope: 0, reversibility: 0, sensitivity: 0, confidence: 1 },
      budget_cap_tokens: 1000,
    },
  },
};

let cachedPolicyPath: string | null = null;
let cachedPolicy: AutonomousOpsPolicy | null = null;
let cachedPolicySourceHealthy = false;
let cachedPolicyMtimeMs: number | null = null;

function getPolicyPath(): string {
  return process.env.KYBERION_AUTONOMOUS_OPS_POLICY_PATH?.trim() || DEFAULT_POLICY_PATH;
}

function loadPolicyFromPath(policyPath: string): AutonomousOpsPolicy {
  const raw = safeReadFile(policyPath, { encoding: 'utf8' }) as string;
  return safeJsonParse<AutonomousOpsPolicy>(raw, 'autonomous ops policy');
}

function cloneFallbackPolicy(): AutonomousOpsPolicy {
  return JSON.parse(JSON.stringify(FALLBACK_POLICY)) as AutonomousOpsPolicy;
}

export function resetAutonomousOpsPolicyCache(): void {
  cachedPolicyPath = null;
  cachedPolicy = null;
  cachedPolicySourceHealthy = false;
  cachedPolicyMtimeMs = null;
}

export function getAutonomousOpsPolicy(): AutonomousOpsPolicy {
  const policyPath = getPolicyPath();
  let currentPolicyMtimeMs: number | null = null;
  if (safeExistsSync(policyPath)) {
    try {
      currentPolicyMtimeMs = safeStat(policyPath).mtimeMs;
    } catch {
      currentPolicyMtimeMs = null;
    }
  }

  if (
    cachedPolicyPath === policyPath &&
    cachedPolicy &&
    cachedPolicyMtimeMs === currentPolicyMtimeMs
  ) {
    return cachedPolicy;
  }

  if (currentPolicyMtimeMs === null) {
    cachedPolicyPath = policyPath;
    cachedPolicy = cloneFallbackPolicy();
    cachedPolicySourceHealthy = false;
    cachedPolicyMtimeMs = null;
    return cachedPolicy;
  }

  try {
    const parsed = loadPolicyFromPath(policyPath);
    cachedPolicyPath = policyPath;
    cachedPolicy = parsed;
    cachedPolicySourceHealthy = true;
    cachedPolicyMtimeMs = currentPolicyMtimeMs;
    return parsed;
  } catch {
    cachedPolicyPath = policyPath;
    cachedPolicy = cloneFallbackPolicy();
    cachedPolicySourceHealthy = false;
    cachedPolicyMtimeMs = currentPolicyMtimeMs;
    return cachedPolicy;
  }
}

function clampAxisScore(score: number | undefined): number {
  if (!Number.isFinite(score ?? Number.NaN)) return 0;
  return Math.max(0, Math.min(3, Math.trunc(score ?? 0)));
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
  const policy = getAutonomousOpsPolicy();

  if (!cachedPolicySourceHealthy) {
    return {
      actionId: input.actionId,
      decision: 'approve',
      allowed: false,
      score: Number.POSITIVE_INFINITY,
      maxScore: policy.decision_thresholds.notify_max_score,
      policyVersion: policy.version,
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
