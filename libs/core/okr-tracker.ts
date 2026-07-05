import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import type { FinancialModel } from './financial-model.js';

export interface OkrKeyResult {
  metric: string;
  target: number | string;
  current: number | string | null;
  due?: string | null;
  owner_role?: string | null;
  source?: 'manual' | 'financial' | 'mission' | 'operational';
  source_ref?: string | null;
}

export interface OkrObjective {
  objective: string;
  key_results: OkrKeyResult[];
}

export interface OkrPeriod {
  period_id: string;
  label: string;
  start_at?: string | null;
  end_at?: string | null;
}

export interface OkrTracker {
  company_id: string;
  tenant_slug: string | null;
  source_kind: 'customer' | 'confidential' | 'public' | 'derived';
  source_path: string;
  period: OkrPeriod;
  objectives: OkrObjective[];
}

export interface OkrTrackerSummary {
  company_id: string;
  tenant_slug: string | null;
  source_kind: OkrTracker['source_kind'];
  objective_count: number;
  key_result_count: number;
  complete_count: number;
  progress_percent: number;
}

export interface OkrAutoUpdateSource {
  financial?: FinancialModel | null;
  missionCompletedCount?: number;
  missionBlockedCount?: number;
  operationalMetrics?: Record<string, number | string | null | undefined>;
}

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

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function resolveOkrPaths(baseDir: string, tenantSlug: string | null): string[] {
  if (!tenantSlug) {
    return [path.join(baseDir, 'knowledge', 'product', 'governance', 'okr.json')];
  }
  return [
    path.join(baseDir, 'customer', tenantSlug, 'okr.json'),
    path.join(baseDir, 'knowledge', 'confidential', tenantSlug, 'okr.json'),
    path.join(baseDir, 'knowledge', 'product', 'governance', 'okr.json'),
  ];
}

function normalizeObjective(objective: OkrObjective): OkrObjective {
  return {
    objective: objective.objective,
    key_results: Array.isArray(objective.key_results)
      ? objective.key_results.map((keyResult) => ({
          metric: keyResult.metric,
          target: keyResult.target,
          current: keyResult.current ?? null,
          due: keyResult.due ?? null,
          owner_role: keyResult.owner_role ?? null,
          source: keyResult.source || 'manual',
          source_ref: keyResult.source_ref ?? null,
        }))
      : [],
  };
}

function buildDerivedOkrTracker(
  companyId: string,
  tenantSlug: string | null,
  sourcePath: string,
  sourceKind: OkrTracker['source_kind']
): OkrTracker {
  return {
    company_id: companyId,
    tenant_slug: tenantSlug,
    source_kind: sourceKind,
    source_path: sourcePath,
    period: {
      period_id: 'current',
      label: 'Current',
    },
    objectives: [],
  };
}

export function resolveOkrTracker(tenantSlug?: string | null, rootDir?: string): OkrTracker {
  const baseDir = resolveBaseDir(rootDir);
  const resolvedTenantSlug = tenantSlug?.trim() || null;
  const companyId = resolvedTenantSlug || 'default';
  for (const candidate of resolveOkrPaths(baseDir, resolvedTenantSlug)) {
    const parsed = loadJsonIfPresent<OkrTracker>(candidate);
    if (!parsed || !Array.isArray(parsed.objectives)) continue;
    return {
      ...parsed,
      company_id: companyId,
      tenant_slug: resolvedTenantSlug,
      source_path: candidate,
      source_kind: candidate.includes('/customer/')
        ? 'customer'
        : candidate.includes('/confidential/')
          ? 'confidential'
          : 'public',
      objectives: parsed.objectives.map(normalizeObjective),
    };
  }

  return buildDerivedOkrTracker(
    companyId,
    resolvedTenantSlug,
    path.join(baseDir, 'knowledge', 'product', 'governance', 'okr.json'),
    'derived'
  );
}

function updateFinancialMetric(keyResult: OkrKeyResult, financial: FinancialModel): OkrKeyResult {
  const latest = financial.periods[financial.periods.length - 1] || null;
  if (!latest) return keyResult;
  const metric = keyResult.metric.toLowerCase();
  if (metric.includes('revenue') && typeof latest.revenue_jpy === 'number') {
    return {
      ...keyResult,
      current: latest.revenue_jpy,
      source: 'financial',
      source_ref: financial.source_path,
    };
  }
  if (
    (metric.includes('gross') || metric.includes('profit')) &&
    typeof latest.gross_profit_jpy === 'number'
  ) {
    return {
      ...keyResult,
      current: latest.gross_profit_jpy,
      source: 'financial',
      source_ref: financial.source_path,
    };
  }
  if (
    (metric.includes('cost') || metric.includes('burn')) &&
    typeof latest.operating_cost_jpy === 'number'
  ) {
    return {
      ...keyResult,
      current: latest.operating_cost_jpy,
      source: 'financial',
      source_ref: financial.source_path,
    };
  }
  if (metric.includes('cash') && typeof latest.cash_balance_jpy === 'number') {
    return {
      ...keyResult,
      current: latest.cash_balance_jpy,
      source: 'financial',
      source_ref: financial.source_path,
    };
  }
  return keyResult;
}

function updateOperationalMetric(
  keyResult: OkrKeyResult,
  operationalMetrics: Record<string, number | string | null | undefined>
): OkrKeyResult {
  const metric = keyResult.metric.toLowerCase();
  for (const [name, value] of Object.entries(operationalMetrics)) {
    if (name.toLowerCase() !== metric) continue;
    const numeric = toNumber(value);
    if (numeric != null) {
      return { ...keyResult, current: numeric, source: 'operational', source_ref: name };
    }
    if (typeof value === 'string' && value.trim()) {
      return { ...keyResult, current: value.trim(), source: 'operational', source_ref: name };
    }
  }
  return keyResult;
}

function updateMissionMetric(
  keyResult: OkrKeyResult,
  missionCompletedCount: number | undefined,
  missionBlockedCount: number | undefined
): OkrKeyResult {
  const metric = keyResult.metric.toLowerCase();
  if (typeof missionCompletedCount === 'number' && metric.includes('completed')) {
    return {
      ...keyResult,
      current: missionCompletedCount,
      source: 'mission',
      source_ref: 'mission_completed_count',
    };
  }
  if (typeof missionBlockedCount === 'number' && metric.includes('blocked')) {
    return {
      ...keyResult,
      current: missionBlockedCount,
      source: 'mission',
      source_ref: 'mission_blocked_count',
    };
  }
  return keyResult;
}

export function hydrateOkrTracker(tracker: OkrTracker, sources: OkrAutoUpdateSource): OkrTracker {
  const operationalMetrics = sources.operationalMetrics || {};
  return {
    ...tracker,
    objectives: tracker.objectives.map((objective) => ({
      objective: objective.objective,
      key_results: objective.key_results.map((keyResult) => {
        let updated = keyResult;
        if (sources.financial) {
          updated = updateFinancialMetric(updated, sources.financial);
        }
        updated = updateMissionMetric(
          updated,
          sources.missionCompletedCount,
          sources.missionBlockedCount
        );
        updated = updateOperationalMetric(updated, operationalMetrics);
        return updated;
      }),
    })),
  };
}

export function summarizeOkrTracker(tracker?: OkrTracker | null): OkrTrackerSummary | undefined {
  if (!tracker) return undefined;
  const keyResults = tracker.objectives.flatMap((objective) => objective.key_results);
  const completeCount = keyResults.filter((keyResult) => {
    const current = keyResult.current;
    if (typeof current === 'number' && typeof keyResult.target === 'number') {
      return current >= keyResult.target;
    }
    if (typeof current === 'string' && typeof keyResult.target === 'string') {
      return current === keyResult.target;
    }
    return false;
  }).length;
  return {
    company_id: tracker.company_id,
    tenant_slug: tracker.tenant_slug,
    source_kind: tracker.source_kind,
    objective_count: tracker.objectives.length,
    key_result_count: keyResults.length,
    complete_count: completeCount,
    progress_percent:
      keyResults.length > 0 ? Math.round((completeCount / keyResults.length) * 100) : 0,
  };
}

export function createOkrTracker(input: {
  companyId: string;
  tenantSlug?: string | null;
  periodLabel?: string;
  objectives: OkrObjective[];
}): OkrTracker {
  return {
    company_id: input.companyId,
    tenant_slug: input.tenantSlug?.trim() || null,
    source_kind: 'derived',
    source_path: path.join(
      pathResolver.rootDir(),
      'knowledge',
      'product',
      'governance',
      'okr.json'
    ),
    period: {
      period_id: 'current',
      label: input.periodLabel || 'Current',
    },
    objectives: input.objectives.map(normalizeObjective),
  };
}

export function isOkrTrackerValid(tracker: OkrTracker): boolean {
  return (
    typeof tracker.company_id === 'string' &&
    Array.isArray(tracker.objectives) &&
    tracker.objectives.every(
      (objective) =>
        typeof objective.objective === 'string' &&
        Array.isArray(objective.key_results) &&
        objective.key_results.every(
          (keyResult) =>
            typeof keyResult.metric === 'string' && typeof keyResult.target !== 'undefined'
        )
    )
  );
}
