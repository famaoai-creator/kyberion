import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';

export interface DecisionThreshold {
  metric: string;
  value: number | string;
  unit?: string;
}

export interface DecisionRight {
  decision_type: string;
  authorized_role: string;
  threshold: DecisionThreshold;
  requires_review_from?: string;
  escalates_to?: string;
  final_decision_holder?: 'human' | 'delegated';
  requires_human_acceptance?: boolean;
}

export interface DecisionRightsMatrix {
  version: string;
  company_id: string;
  tenant_slug: string | null;
  source_kind: 'customer' | 'confidential' | 'public';
  source_path: string;
  decisions: DecisionRight[];
}

export interface DecisionRightsSummary {
  company_id: string;
  tenant_slug: string | null;
  source_kind: DecisionRightsMatrix['source_kind'];
  source_path: string;
  decision_count: number;
  decision_types: string[];
}

export interface DecisionRightsEvaluation {
  decisionType: string;
  authorizedRole: string | null;
  thresholdMetric: string | null;
  thresholdValue: number | string | null;
  requiresEscalation: boolean;
  escalationReason: string | null;
  finalDecisionHolder: 'human' | 'delegated' | null;
  requiresHumanAcceptance: boolean;
}

const DEFAULT_DECISION_RIGHTS_PATHS = [
  (baseDir: string, tenantSlug: string) =>
    path.join(baseDir, 'customer', tenantSlug, 'decision-rights.json'),
  (baseDir: string, tenantSlug: string) =>
    path.join(
      baseDir,
      'knowledge',
      'confidential',
      tenantSlug,
      'governance',
      'decision-rights.json'
    ),
  (baseDir: string, tenantSlug: string) =>
    path.join(baseDir, 'knowledge', 'confidential', tenantSlug, 'decision-rights.json'),
  (baseDir: string) =>
    path.join(baseDir, 'knowledge', 'product', 'governance', 'decision-rights.json'),
];

function resolveBaseDir(rootDir?: string): string {
  return rootDir ? path.resolve(rootDir) : pathResolver.rootDir();
}

function loadJsonIfPresent<T>(filePath: string): T | null {
  if (!safeExistsSync(filePath)) return null;
  try {
    return JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as T;
  } catch {
    return null;
  }
}

function isDecisionRightsMatrix(value: unknown): value is DecisionRightsMatrix {
  if (!value || typeof value !== 'object') return false;
  const matrix = value as Record<string, unknown>;
  return (
    typeof matrix.version === 'string' &&
    typeof matrix.company_id === 'string' &&
    Array.isArray(matrix.decisions) &&
    typeof matrix.source_kind === 'string' &&
    typeof matrix.source_path === 'string'
  );
}

function normalizeLoadedMatrix(
  matrix: DecisionRightsMatrix,
  sourcePath: string,
  sourceKind: DecisionRightsMatrix['source_kind'],
  companyId: string,
  tenantSlug: string | null
): DecisionRightsMatrix {
  return {
    ...matrix,
    company_id: companyId,
    tenant_slug: tenantSlug,
    source_path: sourcePath,
    source_kind: sourceKind,
    decisions: Array.isArray(matrix.decisions) ? matrix.decisions : [],
  };
}

export function resolveDecisionRightsMatrix(
  tenantSlug?: string | null,
  rootDir?: string
): DecisionRightsMatrix {
  const baseDir = resolveBaseDir(rootDir);
  const resolvedTenantSlug = tenantSlug?.trim() || null;
  const companyId = resolvedTenantSlug || 'default';
  const candidates = resolvedTenantSlug
    ? DEFAULT_DECISION_RIGHTS_PATHS.map((builder) => builder(baseDir, resolvedTenantSlug))
    : [path.join(baseDir, 'knowledge', 'product', 'governance', 'decision-rights.json')];

  for (const candidate of candidates) {
    const parsed = loadJsonIfPresent<DecisionRightsMatrix>(candidate);
    if (!parsed || !isDecisionRightsMatrix(parsed)) continue;
    const sourceKind: DecisionRightsMatrix['source_kind'] = candidate.includes('/customer/')
      ? 'customer'
      : candidate.includes('/confidential/')
        ? 'confidential'
        : 'public';
    return normalizeLoadedMatrix(parsed, candidate, sourceKind, companyId, resolvedTenantSlug);
  }

  return {
    version: '1.0.0',
    company_id: companyId,
    tenant_slug: resolvedTenantSlug,
    source_kind: 'public',
    source_path: path.join(baseDir, 'knowledge', 'product', 'governance', 'decision-rights.json'),
    decisions: [],
  };
}

export function summarizeDecisionRights(
  matrix?: DecisionRightsMatrix | null
): DecisionRightsSummary | undefined {
  if (!matrix) return undefined;
  return {
    company_id: matrix.company_id,
    tenant_slug: matrix.tenant_slug,
    source_kind: matrix.source_kind,
    source_path: matrix.source_path,
    decision_count: matrix.decisions.length,
    decision_types: matrix.decisions.map((decision) => decision.decision_type).sort(),
  };
}

export function evaluateDecisionRights(
  matrix: DecisionRightsMatrix | null | undefined,
  input: {
    decisionType?: string;
    actorRole?: string;
    amount?: number | null;
    riskLevel?: string | null;
  }
): DecisionRightsEvaluation | null {
  if (!matrix) return null;
  const decisionType = input.decisionType?.trim();
  if (!decisionType) return null;
  const matched = matrix.decisions.find((decision) => decision.decision_type === decisionType);
  if (!matched) return null;

  const thresholdMetric = matched.threshold.metric;
  const thresholdValue = matched.threshold.value;
  const actorRole = input.actorRole?.trim() || null;
  const authorizedRole = matched.authorized_role || null;
  const roleMismatch = Boolean(actorRole && authorizedRole && actorRole !== authorizedRole);

  let overThreshold = false;
  if (typeof input.amount === 'number' && Number.isFinite(input.amount)) {
    if (typeof thresholdValue === 'number') {
      overThreshold = input.amount > thresholdValue;
    } else if (typeof thresholdValue === 'string' && thresholdMetric === 'risk_level') {
      const rank = { low: 1, medium: 2, high: 3, critical: 4 } as const;
      const amountRank = rank[(input.riskLevel || '').toLowerCase() as keyof typeof rank] || 0;
      const thresholdRank = rank[thresholdValue.toLowerCase() as keyof typeof rank] || 0;
      overThreshold = amountRank > thresholdRank;
    }
  } else if (typeof input.riskLevel === 'string' && typeof thresholdValue === 'string') {
    const rank = { low: 1, medium: 2, high: 3, critical: 4 } as const;
    const inputRank = rank[input.riskLevel.toLowerCase() as keyof typeof rank] || 0;
    const thresholdRank = rank[thresholdValue.toLowerCase() as keyof typeof rank] || 0;
    overThreshold = inputRank > thresholdRank;
  }

  const finalDecisionHolder = matched.final_decision_holder || null;
  const requiresHumanAcceptance =
    matched.requires_human_acceptance === true || finalDecisionHolder === 'human';
  const requiresEscalation = roleMismatch || overThreshold || requiresHumanAcceptance;
  const escalationReason = roleMismatch
    ? `actor role ${actorRole} is not authorized for ${decisionType}`
    : overThreshold
      ? `decision value exceeds threshold ${String(thresholdValue)}`
      : requiresHumanAcceptance
        ? 'final decision holder is human'
        : null;

  return {
    decisionType,
    authorizedRole,
    thresholdMetric,
    thresholdValue,
    requiresEscalation,
    escalationReason,
    finalDecisionHolder,
    requiresHumanAcceptance,
  };
}
