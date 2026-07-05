import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import {
  resolveFinancialModel,
  summarizeFinancialModel,
  type FinancialModel,
} from './financial-model.js';
import { resolveOkrTracker, summarizeOkrTracker, type OkrTracker } from './okr-tracker.js';

export interface FinanceControllerCostReport {
  totalCostUsd: number | null;
  totalTokens: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  sourcePath: string | null;
}

export interface FinanceControllerThresholds {
  budgetUtilizationWarning: number;
  budgetUtilizationCritical: number;
  negativeGrossProfitBudgetMode: boolean;
  lowOkrProgressWarning: number;
  lowOkrProgressCritical: number;
  highTokenUsageWarning: number;
  highTokenUsageCritical: number;
}

export interface FinanceControllerDecision {
  mode: 'growth' | 'monitor' | 'cost_cutting';
  shouldCutCosts: boolean;
  reasons: string[];
  signals: {
    revenueJpy: number | null;
    operatingCostJpy: number | null;
    grossProfitJpy: number | null;
    budgetJpy: number | null;
    budgetUtilization: number | null;
    okrProgressPercent: number | null;
    costReportTotalUsd: number | null;
    costReportTotalTokens: number | null;
  };
  thresholds: FinanceControllerThresholds;
  sources: {
    financialPath: string;
    okrPath: string;
    costReportPath: string | null;
  };
}

export interface ResolveFinanceControllerDecisionInput {
  tenantSlug?: string | null;
  rootDir?: string;
  financial?: FinancialModel | null;
  okr?: OkrTracker | null;
  costReport?: FinanceControllerCostReport | null;
  thresholds?: Partial<FinanceControllerThresholds>;
}

const DEFAULT_THRESHOLDS: FinanceControllerThresholds = {
  budgetUtilizationWarning: 0.75,
  budgetUtilizationCritical: 0.9,
  negativeGrossProfitBudgetMode: true,
  lowOkrProgressWarning: 75,
  lowOkrProgressCritical: 50,
  highTokenUsageWarning: 5000,
  highTokenUsageCritical: 20000,
};

function resolveBaseDir(rootDir?: string): string {
  return rootDir ? path.resolve(rootDir) : pathResolver.rootDir();
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function readJsonIfPresent<T>(filePath: string): T | null {
  if (!safeExistsSync(filePath)) return null;
  try {
    return JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as T;
  } catch {
    return null;
  }
}

function resolveCostReport(baseDir: string): FinanceControllerCostReport | null {
  const candidates = [
    path.join(baseDir, 'evidence', 'cost-report.json'),
    pathResolver.sharedTmp('cost-report.json'),
    path.join(baseDir, 'active', 'shared', 'tmp', 'cost-report.json'),
  ];
  for (const candidate of candidates) {
    const parsed = readJsonIfPresent<Record<string, unknown>>(candidate);
    if (!parsed) continue;
    const totals = (parsed.totals as Record<string, unknown> | undefined) || parsed;
    const nestedUsage =
      (parsed.usage as Record<string, unknown> | undefined) ||
      (parsed.metrics as Record<string, unknown> | undefined) ||
      (parsed.summary as Record<string, unknown> | undefined) ||
      {};
    const totalCostUsd = toNumber(
      totals.totalCostUsd ??
        totals.total_cost_usd ??
        totals.costUsd ??
        totals.cost_usd ??
        nestedUsage.totalCostUsd ??
        nestedUsage.total_cost_usd
    );
    const totalTokens = toNumber(
      totals.totalTokens ??
        totals.total_tokens ??
        nestedUsage.totalTokens ??
        nestedUsage.total_tokens
    );
    const promptTokens = toNumber(
      totals.promptTokens ??
        totals.prompt_tokens ??
        nestedUsage.promptTokens ??
        nestedUsage.prompt_tokens
    );
    const completionTokens = toNumber(
      totals.completionTokens ??
        totals.completion_tokens ??
        nestedUsage.completionTokens ??
        nestedUsage.completion_tokens
    );
    if (
      totalCostUsd != null ||
      totalTokens != null ||
      promptTokens != null ||
      completionTokens != null
    ) {
      return {
        totalCostUsd,
        totalTokens,
        promptTokens,
        completionTokens,
        sourcePath: candidate,
      };
    }
  }
  return null;
}

function summarizeObjectiveProgress(okr?: OkrTracker | null): number | null {
  if (!okr) return null;
  const keyResults = okr.objectives.flatMap((objective) => objective.key_results);
  if (keyResults.length === 0) return null;
  const completeCount = keyResults.filter((keyResult) => {
    if (typeof keyResult.current === 'number' && typeof keyResult.target === 'number') {
      return keyResult.current >= keyResult.target;
    }
    if (typeof keyResult.current === 'string' && typeof keyResult.target === 'string') {
      return keyResult.current === keyResult.target;
    }
    return false;
  }).length;
  return Math.round((completeCount / keyResults.length) * 100);
}

export function resolveFinanceControllerDecision(
  input: ResolveFinanceControllerDecisionInput = {}
): FinanceControllerDecision {
  const baseDir = resolveBaseDir(input.rootDir);
  const financial = input.financial || resolveFinancialModel(input.tenantSlug ?? null, baseDir);
  const okr = input.okr || resolveOkrTracker(input.tenantSlug ?? null, baseDir);
  const costReport = input.costReport || resolveCostReport(baseDir);
  const latest = financial.periods[financial.periods.length - 1] || null;
  const budget = latest?.budget_jpy ?? null;
  const operatingCost = latest?.operating_cost_jpy ?? null;
  const grossProfit = latest?.gross_profit_jpy ?? null;
  const revenue = latest?.revenue_jpy ?? null;
  const okrProgressPercent = summarizeObjectiveProgress(okr);
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(input.thresholds || {}) };

  const budgetUtilization =
    budget && operatingCost != null && budget > 0 ? Math.min(1, operatingCost / budget) : null;

  const reasons: string[] = [];
  if (budgetUtilization != null) {
    if (budgetUtilization >= thresholds.budgetUtilizationCritical) {
      reasons.push(`Budget utilization is ${(budgetUtilization * 100).toFixed(1)}%`);
    } else if (budgetUtilization >= thresholds.budgetUtilizationWarning) {
      reasons.push(`Budget utilization is ${(budgetUtilization * 100).toFixed(1)}%`);
    }
  }
  if (
    thresholds.negativeGrossProfitBudgetMode &&
    typeof grossProfit === 'number' &&
    grossProfit < 0
  ) {
    reasons.push('Gross profit is negative');
  }
  if (
    typeof okrProgressPercent === 'number' &&
    okrProgressPercent < thresholds.lowOkrProgressCritical
  ) {
    reasons.push(`OKR progress is low (${okrProgressPercent}%)`);
  } else if (
    typeof okrProgressPercent === 'number' &&
    okrProgressPercent < thresholds.lowOkrProgressWarning
  ) {
    reasons.push(`OKR progress is behind (${okrProgressPercent}%)`);
  }
  if (
    typeof costReport?.totalTokens === 'number' &&
    costReport.totalTokens >= thresholds.highTokenUsageCritical
  ) {
    reasons.push(`Cost report token usage is high (${costReport.totalTokens} tokens)`);
  } else if (
    typeof costReport?.totalTokens === 'number' &&
    costReport.totalTokens >= thresholds.highTokenUsageWarning
  ) {
    reasons.push(`Cost report token usage is elevated (${costReport.totalTokens} tokens)`);
  }

  const shouldCutCosts = Boolean(
    (budgetUtilization != null && budgetUtilization >= thresholds.budgetUtilizationCritical) ||
    (thresholds.negativeGrossProfitBudgetMode &&
      typeof grossProfit === 'number' &&
      grossProfit < 0) ||
    (typeof okrProgressPercent === 'number' &&
      okrProgressPercent < thresholds.lowOkrProgressCritical) ||
    (typeof costReport?.totalTokens === 'number' &&
      costReport.totalTokens >= thresholds.highTokenUsageCritical)
  );

  const monitorOnly =
    !shouldCutCosts &&
    Boolean(
      (budgetUtilization != null && budgetUtilization >= thresholds.budgetUtilizationWarning) ||
      (typeof okrProgressPercent === 'number' &&
        okrProgressPercent < thresholds.lowOkrProgressWarning) ||
      (typeof costReport?.totalTokens === 'number' &&
        costReport.totalTokens >= thresholds.highTokenUsageWarning)
    );

  return {
    mode: shouldCutCosts ? 'cost_cutting' : monitorOnly ? 'monitor' : 'growth',
    shouldCutCosts,
    reasons,
    signals: {
      revenueJpy: revenue,
      operatingCostJpy: operatingCost,
      grossProfitJpy: grossProfit,
      budgetJpy: budget,
      budgetUtilization,
      okrProgressPercent,
      costReportTotalUsd: costReport?.totalCostUsd ?? null,
      costReportTotalTokens: costReport?.totalTokens ?? null,
    },
    thresholds,
    sources: {
      financialPath: financial.source_path,
      okrPath: okr.source_path,
      costReportPath: costReport?.sourcePath || null,
    },
  };
}

export function summarizeFinanceControllerDecision(
  input: ResolveFinanceControllerDecisionInput = {}
): FinanceControllerDecision {
  return resolveFinanceControllerDecision(input);
}

export function resolveFinanceControllerDecisionSummary(
  tenantSlug?: string | null,
  rootDir?: string
): FinanceControllerDecision {
  return resolveFinanceControllerDecision({ tenantSlug, rootDir });
}
