import { posix } from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { clamp } from '../foundation/text.js';
import { assertSafeRepositoryPath } from '../secure-io.js';
import { resolveIdentityContext } from '../authority.js';

export type AutonomousOpsDecision = 'auto' | 'notify' | 'approve';
export type AutonomousOpsMode = 'apply' | 'dry_run';
export type AutonomousOpsAxisId = 'scope' | 'reversibility' | 'sensitivity' | 'confidence';

export type AutonomousOpsRequiredEvidence = 'ci_green' | 'tests_green' | 'cross_provider_review';

export interface AutonomousOpsActionPolicy {
  title: string;
  description: string;
  axis_scores: Record<AutonomousOpsAxisId, number>;
  budget_cap_tokens?: number;
  action_class?: string;
  veto_window_minutes?: number;
  max_attempts?: number;
  required_evidence?: AutonomousOpsRequiredEvidence[];
  shadow?: boolean;
}

export interface AutonomousOpsPolicy {
  version: string;
  decision_thresholds: {
    auto_max_score: number;
    notify_max_score: number;
  };
  axis_weights: Record<AutonomousOpsAxisId, number>;
  high_risk_paths?: string[];
  never_auto?: string[];
  active_hours?: { start: string; end: string; timezone: string };
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
  /** Repo-relative paths the action would change; any high-risk match forces approve. */
  changedPaths?: string[];
  /** Additional action classes detected for this change (e.g. dependency_major); raise-only. */
  detectedClasses?: string[];
  /** An agent may ask for a stricter tier than the computed one, never a looser one. */
  requestedDecision?: AutonomousOpsDecision;
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
  /** Shadow actions report the computed tier but are never allowed to execute. */
  shadow: boolean;
  /** Rules that raised the tier above the score-based decision. */
  escalations: string[];
  highRiskPathMatches: string[];
  actionClass?: string;
  vetoWindowMinutes?: number;
  maxAttempts?: number;
  requiredEvidence?: AutonomousOpsRequiredEvidence[];
}

const DECISION_RANK: Record<AutonomousOpsDecision, number> = { auto: 0, notify: 1, approve: 2 };

function globToPattern(glob: string): string {
  if (glob.endsWith('/**')) return `${globToPattern(glob.slice(0, -3))}(?:/.*)?`;
  let pattern = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          pattern += '(?:.*/)?';
        } else {
          pattern += '.*';
        }
      } else {
        pattern += '[^/]*';
      }
    } else if (char === '?') {
      pattern += '[^/]';
    } else {
      pattern += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return pattern;
}

function normalizeRepoPath(path: string): string {
  const slashed = path.trim().replace(/\\/g, '/');
  return slashed ? posix.normalize(slashed).replace(/^\.\//, '') : '';
}

function escapesRepository(path: string): boolean {
  return path.startsWith('/') || path === '..' || path.startsWith('../') || /^[a-z]:/i.test(path);
}

/**
 * Case-insensitive because the default macOS and Windows file systems are, and paths
 * escaping the repository (absolute, drive-letter or `../`) always count as high risk.
 */
export function matchHighRiskPaths(paths: readonly string[], globs: readonly string[]): string[] {
  const matchers = globs.map((glob) => new RegExp(`^${globToPattern(glob)}$`, 'i'));
  return paths
    .map(normalizeRepoPath)
    .filter(
      (path) => path && (escapesRepository(path) || matchers.some((matcher) => matcher.test(path)))
    );
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

function floorAxisScore(base: number, override: number | undefined): number {
  if (override === undefined) return clampAxisScore(base);
  return Math.max(clampAxisScore(base), clampAxisScore(override));
}

function stricterBudgetCap(
  base: number | undefined,
  override: number | undefined
): number | undefined {
  if (base === undefined) return override;
  if (override === undefined) return base;
  return Math.min(base, override);
}

/**
 * Tenant overrides are floors: they may raise axis scores or lower budget caps, never relax
 * them, and cannot define actions the base policy lacks.
 */
function mergeActionPolicy(
  base: AutonomousOpsActionPolicy,
  override: Partial<AutonomousOpsActionPolicy> | undefined
): AutonomousOpsActionPolicy {
  if (!override) return base;
  const axes: AutonomousOpsAxisId[] = ['scope', 'reversibility', 'sensitivity', 'confidence'];
  const axisScores = Object.fromEntries(
    axes.map((axis) => [axis, floorAxisScore(base.axis_scores[axis], override.axis_scores?.[axis])])
  ) as Record<AutonomousOpsAxisId, number>;
  return {
    ...base,
    title: override.title ?? base.title,
    description: override.description ?? base.description,
    axis_scores: axisScores,
    budget_cap_tokens: stricterBudgetCap(base.budget_cap_tokens, override.budget_cap_tokens),
  };
}

function resolveActionPolicy(
  policy: AutonomousOpsPolicy,
  actionId: string,
  tenantSlug?: string
): AutonomousOpsActionPolicy | undefined {
  const base = policy.actions[actionId];
  if (!base || !tenantSlug) return base;
  return mergeActionPolicy(base, policy.tenant_overrides?.[tenantSlug]?.actions?.[actionId]);
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
      shadow: false,
      escalations: [],
      highRiskPathMatches: [],
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
      shadow: false,
      escalations: [],
      highRiskPathMatches: [],
    };
  }

  const score = scoreAction(action, policy);
  const maxScore = policy.decision_thresholds.notify_max_score;
  const shadow = action.shadow === true;
  const escalations: string[] = [];
  const reasons = [`autonomous ops score ${score}/${maxScore} for ${input.actionId}`];
  let highRiskPathMatches: string[] = [];
  const scoreDecision: AutonomousOpsDecision =
    executionMode === 'dry_run' ? 'auto' : decisionFromScore(policy, score);
  let decision = scoreDecision;

  const escalate = (to: AutonomousOpsDecision, rule: string, detail: string) => {
    if (to !== 'approve' && DECISION_RANK[to] <= DECISION_RANK[scoreDecision]) return;
    if (DECISION_RANK[to] > DECISION_RANK[decision]) decision = to;
    escalations.push(rule);
    reasons.push(detail);
  };

  if (executionMode !== 'dry_run') {
    const axes = action.axis_scores;
    const maxedAxes = (Object.keys(axes) as AutonomousOpsAxisId[]).filter(
      (axis) => clampAxisScore(axes[axis]) >= 3
    );
    if (maxedAxes.length > 0) {
      escalate('approve', 'axis_max', `axis at maximum: ${maxedAxes.join(', ')}`);
    }
    if (clampAxisScore(axes.reversibility) >= 2) {
      escalate('notify', 'irreversible', 'reversibility >= 2 requires at least notify');
    }

    const neverAuto = new Set(policy.never_auto ?? []);
    const classes = [action.action_class, ...(input.detectedClasses ?? [])].filter(
      (value): value is string => Boolean(value)
    );
    const neverAutoHits = classes.filter((value) => neverAuto.has(value));
    if (neverAutoHits.length > 0) {
      escalate('approve', 'never_auto', `never-auto class: ${neverAutoHits.join(', ')}`);
    }

    highRiskPathMatches = matchHighRiskPaths(
      input.changedPaths ?? [],
      policy.high_risk_paths ?? []
    );
    if (highRiskPathMatches.length > 0) {
      escalate(
        'approve',
        'high_risk_path',
        `high-risk paths changed: ${highRiskPathMatches.join(', ')}`
      );
    }

    if (input.requestedDecision !== undefined) {
      const requested = Object.hasOwn(DECISION_RANK, input.requestedDecision)
        ? input.requestedDecision
        : 'approve';
      escalate(requested, 'requested', `agent requested ${String(input.requestedDecision)}`);
    }

    if (
      typeof input.estimatedCostTokens === 'number' &&
      Number.isFinite(input.estimatedCostTokens)
    ) {
      const budgetCapTokens = action.budget_cap_tokens;
      if (typeof budgetCapTokens === 'number' && input.estimatedCostTokens > budgetCapTokens) {
        escalate(
          'approve',
          'budget',
          `Estimated cost ${input.estimatedCostTokens} exceeds budget cap ${budgetCapTokens}`
        );
      }
    }
  }

  if (shadow) reasons.push('shadow mode: recorded only, never executed');

  return {
    actionId: input.actionId,
    decision,
    allowed: decision !== 'approve' && !shadow,
    score,
    maxScore,
    policyVersion: policy.version,
    tenantSlug,
    executionMode,
    reason: reasons.join('; '),
    axes: { ...action.axis_scores },
    budgetCapTokens: action.budget_cap_tokens,
    shadow,
    escalations,
    highRiskPathMatches,
    actionClass: action.action_class,
    vetoWindowMinutes: action.veto_window_minutes,
    maxAttempts: action.max_attempts,
    requiredEvidence: action.required_evidence,
  };
}
