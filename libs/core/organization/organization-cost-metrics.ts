/**
 * Organization cost metrics — the usage-ledger counterpart of the organization
 * record metrics. KR specs (`org_metric` + `window_days`), the continuous-ops
 * `organization_metrics` source and the improvement scan all read through this
 * one seam so "what does the organization spend, on which model, and how much
 * of it is price-evidenced" has a single definition.
 */
import { buildCostReportFromHistory, type CostReport } from '../finance/cost-report.js';
import type { KeyResultOrgMetric } from './key-result-spec.js';
import type { OrganizationTier } from './organization-operating-model.js';

export const DEFAULT_COST_METRIC_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface OrganizationCostMetricsScope {
  organizationId?: string;
  tenantSlug?: string;
  /** Part of the organization scope identity; enforcement is reader-side (tier-guard). */
  tier?: OrganizationTier;
}

export interface OrganizationCostMetricsDeps {
  /** Cost-report port; defaults to the real usage-ledger aggregation. */
  loadReport?: typeof buildCostReportFromHistory;
  now?: () => Date;
}

export interface OrganizationCostMetrics {
  window_days: number;
  since: string;
  until: string;
  cost_usd: number;
  llm_tokens: number;
  llm_calls: number;
  /** Calls whose cost evidence is `unknown` — the visibility gap itself. */
  unknown_cost_calls: number;
  cost_complete: boolean;
  /** Ledger partitions tier-guard withheld; totals understate when > 0. */
  withheld_partitions: number;
  report: CostReport;
}

function bucketTokens(report: CostReport): number {
  return report.by_model.reduce(
    (sum, bucket) =>
      sum +
      bucket.prompt_tokens +
      bucket.completion_tokens +
      bucket.cache_read_tokens +
      bucket.cache_write_tokens +
      bucket.cache_write_1h_tokens,
    0
  );
}

/** Reads the org-scoped cost report over a trailing window. */
export function organizationCostMetrics(
  scope: OrganizationCostMetricsScope,
  windowDays: number = DEFAULT_COST_METRIC_WINDOW_DAYS,
  deps: OrganizationCostMetricsDeps = {}
): OrganizationCostMetrics {
  const days =
    Number.isFinite(windowDays) && windowDays > 0
      ? Math.min(windowDays, 90)
      : DEFAULT_COST_METRIC_WINDOW_DAYS;
  const until = (deps.now?.() ?? new Date()).toISOString();
  const since = new Date(Date.parse(until) - days * DAY_MS).toISOString();
  const scopeFilter = {
    ...(scope.organizationId ? { organization_id: scope.organizationId } : {}),
    ...(scope.tenantSlug ? { tenant_slug: scope.tenantSlug } : {}),
  };
  const load = deps.loadReport ?? buildCostReportFromHistory;
  const report = load({
    since,
    until,
    ...(Object.keys(scopeFilter).length > 0 ? { scopeFilter } : {}),
  });
  return {
    window_days: days,
    since,
    until,
    cost_usd: report.total_usd,
    llm_tokens: bucketTokens(report),
    llm_calls: report.calls,
    unknown_cost_calls: report.unknown_cost_calls,
    cost_complete: report.cost_complete,
    withheld_partitions: report.withheld_partitions ?? 0,
    report,
  };
}

/** Maps a cost org-metric name onto its measured value; hygiene metrics return undefined. */
export function organizationCostMetricValue(
  metric: KeyResultOrgMetric,
  measured: OrganizationCostMetrics
): number | undefined {
  switch (metric) {
    case 'cost_usd':
      return measured.cost_usd;
    case 'llm_tokens':
      return measured.llm_tokens;
    case 'llm_calls':
      return measured.llm_calls;
    case 'unknown_cost_calls':
      return measured.unknown_cost_calls;
    default:
      return undefined;
  }
}
