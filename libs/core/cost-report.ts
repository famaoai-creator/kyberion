import {
  metrics,
  metricsWithheldNotice,
  type ExecutionMetricsReadScope,
  type ResourceUsageReadScope,
  type ResourceUsageStatus,
} from './metrics.js';
import { eventScopeMatches, type EventScope, type EventScopeFilter } from './event-scope.js';
import { resolveScopeForRecord } from './scope-migration.js';
import {
  normalizeUsageCause,
  resolveUsageCostAccounting,
  type UsageCause,
  type UsageCostAccounting,
  type UsageCostStatus,
} from './usage-accounting.js';

/**
 * cost-report.ts — OP-01 Task 2: aggregate the usage ledger into
 * per-mission / per-model / per-day cost views.
 *
 * Cost certainty is separate from usage provenance and commitment lifecycle.
 * Provider-reported cash (including zero) beats token-rate fallback. Included
 * runs retain API reference estimates without adding incremental cash, and
 * unpriced/unknown-billing runs remain counted with explicit incompleteness.
 * Legacy sdk_cost_usd/cost_usd/estimated rows remain readable.
 */

export interface CostLedgerEntry extends UsageCostAccounting {
  timestamp?: string;
  component?: string;
  model?: string;
  mission_id?: string;
  cost_usd?: number | null;
  source?: string;
  sdk_cost_usd?: number;
  estimated?: boolean;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    cache_write_1h_tokens?: number;
  };
  type?: string;
  actor_id?: string;
  customer_id?: string;
  cost_center?: string;
  cause?: UsageCause;
  status?: ResourceUsageStatus;
  scope?: EventScope;
}

export interface CostBucket {
  key: string;
  cost_usd: number;
  estimated_cost_usd: number;
  reference_usd: number;
  reference_cost_calls: number;
  actual_cost_calls: number;
  estimated_cost_calls: number;
  included_calls: number;
  unknown_cost_calls: number;
  cost_complete: boolean;
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cache_write_1h_tokens: number;
}

export interface CostReport {
  since: string | null;
  until: string | null;
  total_usd: number;
  estimated_usd: number;
  reference_usd: number;
  reference_cost_calls: number;
  actual_cost_calls: number;
  estimated_cost_calls: number;
  included_calls: number;
  unknown_cost_calls: number;
  cost_complete: boolean;
  calls: number;
  by_mission: CostBucket[];
  by_model: CostBucket[];
  by_day: CostBucket[];
  actual_usd: number;
  committed_usd: number;
  resource_usage_entries: number;
  resource_usage_cost_usd: number;
  by_actor: CostBucket[];
  by_customer: CostBucket[];
  by_cost_center: CostBucket[];
  by_tenant: CostBucket[];
  by_organization: CostBucket[];
  by_project: CostBucket[];
  by_cause: CostBucket[];
  /**
   * Metrics partitions tier-guard withheld from this reader (persona tier rules
   * or tenant binding); when set, every total above is partial.
   */
  withheld_partitions?: number;
  /** User-facing sentence saying the report is partial (set with withheld_partitions). */
  partial_notice?: string;
}

export function effectiveCostUsd(entry: CostLedgerEntry): number {
  return resolveUsageCost(entry).costUsd ?? 0;
}

export function resolveUsageCost(entry: CostLedgerEntry): {
  costUsd: number | null;
  referenceUsd: number | null;
  costStatus: UsageCostStatus;
} {
  const resolved = resolveUsageCostAccounting(entry);
  return {
    costUsd: resolved.cost_usd,
    referenceUsd: resolved.reference_cost_usd ?? null,
    costStatus: resolved.cost_status,
  };
}

function round(value: number): number {
  return Math.round(value * 100000) / 100000;
}

function statusOf(entry: CostLedgerEntry): ResourceUsageStatus {
  return (
    entry.status || (resolveUsageCost(entry).costStatus === 'estimated' ? 'estimated' : 'actual')
  );
}

function bucketize(
  entries: Array<{ entry: CostLedgerEntry; cost: number }>,
  keyOf: (entry: CostLedgerEntry) => string
): CostBucket[] {
  const buckets = new Map<string, CostBucket>();
  for (const { entry, cost } of entries) {
    const key = keyOf(entry);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        key,
        cost_usd: 0,
        estimated_cost_usd: 0,
        reference_usd: 0,
        reference_cost_calls: 0,
        actual_cost_calls: 0,
        estimated_cost_calls: 0,
        included_calls: 0,
        unknown_cost_calls: 0,
        cost_complete: true,
        calls: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cache_write_1h_tokens: 0,
      };
      buckets.set(key, bucket);
    }
    bucket.cost_usd += cost;
    const resolved = resolveUsageCost(entry);
    bucket.reference_usd += resolved.referenceUsd ?? 0;
    if (resolved.referenceUsd !== null) bucket.reference_cost_calls++;
    if (resolved.costStatus === 'actual') bucket.actual_cost_calls++;
    if (resolved.costStatus === 'estimated') bucket.estimated_cost_calls++;
    if (resolved.costStatus === 'included') bucket.included_calls++;
    if (resolved.costStatus === 'unknown') {
      bucket.unknown_cost_calls++;
      bucket.cost_complete = false;
    }
    if (statusOf(entry) === 'estimated') bucket.estimated_cost_usd += cost;
    bucket.calls += 1;
    bucket.prompt_tokens += entry.usage?.prompt_tokens ?? 0;
    bucket.completion_tokens += entry.usage?.completion_tokens ?? 0;
    bucket.cache_read_tokens += entry.usage?.cache_read_tokens ?? 0;
    bucket.cache_write_tokens += entry.usage?.cache_write_tokens ?? 0;
    bucket.cache_write_1h_tokens += entry.usage?.cache_write_1h_tokens ?? 0;
  }
  return [...buckets.values()]
    .map((bucket) => ({
      ...bucket,
      cost_usd: round(bucket.cost_usd),
      estimated_cost_usd: round(bucket.estimated_cost_usd),
      reference_usd: round(bucket.reference_usd),
    }))
    .sort((left, right) => right.cost_usd - left.cost_usd);
}

function scopeOf(entry: CostLedgerEntry): EventScope | undefined {
  return resolveScopeForRecord(entry as unknown as Record<string, unknown>).scope;
}

function scopeKey(entry: CostLedgerEntry, key: keyof EventScope, emptyLabel: string): string {
  return String(scopeOf(entry)?.[key] || emptyLabel);
}

export function buildCostReport(
  entries: CostLedgerEntry[],
  options: { since?: string; until?: string; scopeFilter?: EventScopeFilter } = {}
): CostReport {
  const sinceMs = options.since ? Date.parse(options.since) : Number.NEGATIVE_INFINITY;
  const untilMs = options.until ? Date.parse(options.until) : Number.POSITIVE_INFINITY;

  const costed: Array<{ entry: CostLedgerEntry; cost: number }> = [];
  const resourceUsageEntries: CostLedgerEntry[] = [];
  for (const entry of entries) {
    const at = Date.parse(String(entry.timestamp || ''));
    if (!Number.isFinite(at) || at < sinceMs || at > untilMs) continue;
    if (options.scopeFilter && !eventScopeMatches(scopeOf(entry), options.scopeFilter)) continue;
    if (entry.type === 'resource_usage') resourceUsageEntries.push(entry);
    const cost = effectiveCostUsd(entry);
    const hasEvidence =
      (entry.cost_usd !== undefined && entry.cost_usd !== 0) ||
      entry.cost_status !== undefined ||
      entry.billing_mode !== undefined ||
      entry.usage !== undefined ||
      entry.sdk_cost_usd !== undefined ||
      entry.reported_cost_usd !== undefined ||
      entry.reference_cost_usd !== undefined;
    // Preserve legacy zero-only row filtering, but retain known zero reports,
    // included runs and unknown evidence so they can never disappear as free.
    if (cost <= 0 && !hasEvidence) continue;
    costed.push({ entry, cost });
  }

  const total = costed.reduce((sum, item) => sum + item.cost, 0);
  const estimated = costed.reduce(
    (sum, item) => sum + (statusOf(item.entry) === 'estimated' ? item.cost : 0),
    0
  );
  const actual = costed.reduce(
    (sum, item) => sum + (statusOf(item.entry) === 'actual' ? item.cost : 0),
    0
  );
  const committed = costed.reduce(
    (sum, item) => sum + (statusOf(item.entry) === 'committed' ? item.cost : 0),
    0
  );
  const resourceUsageCost = resourceUsageEntries.reduce(
    (sum, entry) => sum + effectiveCostUsd(entry),
    0
  );

  return {
    since: options.since ?? null,
    until: options.until ?? null,
    total_usd: round(total),
    estimated_usd: round(estimated),
    reference_usd: round(
      costed.reduce((sum, item) => sum + (resolveUsageCost(item.entry).referenceUsd ?? 0), 0)
    ),
    reference_cost_calls: costed.filter(
      (item) => resolveUsageCost(item.entry).referenceUsd !== null
    ).length,
    actual_cost_calls: costed.filter((item) => resolveUsageCost(item.entry).costStatus === 'actual')
      .length,
    estimated_cost_calls: costed.filter(
      (item) => resolveUsageCost(item.entry).costStatus === 'estimated'
    ).length,
    included_calls: costed.filter((item) => resolveUsageCost(item.entry).costStatus === 'included')
      .length,
    unknown_cost_calls: costed.filter(
      (item) => resolveUsageCost(item.entry).costStatus === 'unknown'
    ).length,
    cost_complete: costed.every((item) => resolveUsageCost(item.entry).costStatus !== 'unknown'),
    calls: costed.length,
    by_mission: bucketize(costed, (entry) => entry.mission_id || '(no mission)'),
    by_model: bucketize(costed, (entry) => entry.model || '(unknown model)'),
    by_day: bucketize(costed, (entry) => String(entry.timestamp).slice(0, 10)).sort((a, b) =>
      a.key.localeCompare(b.key)
    ),
    actual_usd: round(actual),
    committed_usd: round(committed),
    resource_usage_entries: resourceUsageEntries.length,
    resource_usage_cost_usd: round(resourceUsageCost),
    by_actor: bucketize(costed, (entry) => entry.actor_id || '(no actor)'),
    by_customer: bucketize(costed, (entry) => entry.customer_id || '(no customer)'),
    by_cost_center: bucketize(costed, (entry) => entry.cost_center || '(no cost center)'),
    by_tenant: bucketize(costed, (entry) => scopeKey(entry, 'tenant_slug', '(system)')),
    by_organization: bucketize(costed, (entry) =>
      scopeKey(entry, 'organization_id', '(no organization)')
    ),
    by_project: bucketize(costed, (entry) => scopeKey(entry, 'project_id', '(no project)')),
    by_cause: bucketize(costed, (entry) => normalizeUsageCause(entry.cause)),
  };
}

/**
 * Resource-usage partitions a cost report reads. A tenant filter reads only
 * those tenants' partitions (plus their legacy rows); without one the report
 * is the operator aggregate over every partition this process may read —
 * tier-guard still withholds other tenants' partitions from a tenant-bound
 * process.
 */
export function resourceUsageReadFor(filter?: EventScopeFilter): ResourceUsageReadScope {
  const tenants =
    filter?.tenant_slugs && filter.tenant_slugs !== 'all'
      ? filter.tenant_slugs
      : filter?.tenant_slug
        ? [filter.tenant_slug]
        : undefined;
  return tenants ? { tenants } : { all: true };
}

/**
 * Execution-metrics partitions a cost report reads. A tenant filter reads those
 * tenants' partitions plus the system partition: unscoped rows (attributed by
 * mission id) are still matched to the tenant by the report's scope filter.
 * Without a filter it is the operator aggregate, as for resource usage.
 */
export function executionMetricsReadFor(filter?: EventScopeFilter): ExecutionMetricsReadScope {
  const read = resourceUsageReadFor(filter);
  return 'tenants' in read ? { ...read, includeSystem: true } : read;
}

export function buildCostReportFromHistory(
  options: { since?: string; until?: string; scopeFilter?: EventScopeFilter } = {}
): CostReport {
  let withheld = 0;
  const onWithheld = (partitions: number) => {
    withheld += partitions;
  };
  const report = buildCostReport(
    [
      ...(metrics.loadHistory({
        read: executionMetricsReadFor(options.scopeFilter),
        onWithheld,
      }) as CostLedgerEntry[]),
      ...(metrics.loadResourceUsageHistory(resourceUsageReadFor(options.scopeFilter), {
        onWithheld,
      }) as CostLedgerEntry[]),
    ],
    options
  );
  const notice = metricsWithheldNotice('cost report', withheld);
  return notice
    ? { ...report, cost_complete: false, withheld_partitions: withheld, partial_notice: notice }
    : report;
}

export function formatCostReport(report: CostReport, topN = 5): string[] {
  const lines: string[] = [
    `Cost report${report.since ? ` since ${report.since}` : ''}: ` +
      `${report.cost_complete ? 'incremental cash' : 'known incremental subtotal'} $${report.total_usd.toFixed(4)} across ${report.calls} call(s)` +
      (report.estimated_usd > 0 ? ` (incl. ~$${report.estimated_usd.toFixed(4)} estimated)` : ''),
  ];
  if (report.partial_notice) lines.push(`PARTIAL: ${report.partial_notice}`);
  lines.push(
    `Cost certainty: ${report.actual_cost_calls} actual, ${report.estimated_cost_calls} estimated, ${report.included_calls} included, ${report.unknown_cost_calls} unknown.`
  );
  lines.push(
    report.reference_cost_calls > 0
      ? `API-equivalent reference: $${report.reference_usd.toFixed(4)} across ${report.reference_cost_calls} call(s); not an incremental charge.`
      : 'API-equivalent reference: unavailable.'
  );
  const section = (title: string, buckets: CostBucket[]) => {
    lines.push(`${title}:`);
    for (const bucket of buckets.slice(0, topN)) {
      const amount =
        bucket.unknown_cost_calls > 0
          ? `known subtotal $${bucket.cost_usd.toFixed(4)}; ${bucket.unknown_cost_calls} unknown`
          : bucket.included_calls > 0 &&
              bucket.actual_cost_calls === 0 &&
              bucket.estimated_cost_calls === 0
            ? 'included'
            : `$${bucket.cost_usd.toFixed(4)}`;
      lines.push(
        `  ${bucket.key}: ${amount} ` +
          `(${bucket.calls} calls, ${bucket.prompt_tokens}+${bucket.completion_tokens} tokens)`
      );
    }
    if (buckets.length === 0) lines.push('  (none)');
  };
  section('By mission', report.by_mission);
  section('By model', report.by_model);
  section('By tenant', report.by_tenant);
  section('By day', report.by_day);
  return lines;
}
