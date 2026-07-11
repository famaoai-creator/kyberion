import { metrics, type ResourceUsageStatus } from './metrics.js';

/**
 * cost-report.ts — OP-01 Task 2: aggregate the usage ledger into
 * per-mission / per-model / per-day cost views.
 *
 * Cost source priority (Task 2.2): the Agent SDK's real total
 * (`sdk_cost_usd`) wins when present; otherwise the token×registry figure
 * (`cost_usd`) computed at record time. Entries flagged `estimated: true`
 * (CLI backends) are counted but also surfaced separately so operators can
 * see how much of the total is approximation.
 */

export interface CostLedgerEntry {
  timestamp?: string;
  component?: string;
  model?: string;
  mission_id?: string;
  cost_usd?: number;
  sdk_cost_usd?: number;
  estimated?: boolean;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  type?: string;
  actor_id?: string;
  customer_id?: string;
  cost_center?: string;
  status?: ResourceUsageStatus;
}

export interface CostBucket {
  key: string;
  cost_usd: number;
  estimated_cost_usd: number;
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
}

export interface CostReport {
  since: string | null;
  until: string | null;
  total_usd: number;
  estimated_usd: number;
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
}

export function effectiveCostUsd(entry: CostLedgerEntry): number {
  const sdk = Number(entry.sdk_cost_usd);
  if (Number.isFinite(sdk) && sdk > 0) return sdk;
  const computed = Number(entry.cost_usd);
  return Number.isFinite(computed) && computed > 0 ? computed : 0;
}

function round(value: number): number {
  return Math.round(value * 100000) / 100000;
}

function statusOf(entry: CostLedgerEntry): ResourceUsageStatus {
  return entry.status || (entry.estimated ? 'estimated' : 'actual');
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
        calls: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
      };
      buckets.set(key, bucket);
    }
    bucket.cost_usd += cost;
    if (statusOf(entry) === 'estimated') bucket.estimated_cost_usd += cost;
    bucket.calls += 1;
    bucket.prompt_tokens += entry.usage?.prompt_tokens ?? 0;
    bucket.completion_tokens += entry.usage?.completion_tokens ?? 0;
  }
  return [...buckets.values()]
    .map((bucket) => ({
      ...bucket,
      cost_usd: round(bucket.cost_usd),
      estimated_cost_usd: round(bucket.estimated_cost_usd),
    }))
    .sort((left, right) => right.cost_usd - left.cost_usd);
}

export function buildCostReport(
  entries: CostLedgerEntry[],
  options: { since?: string; until?: string } = {}
): CostReport {
  const sinceMs = options.since ? Date.parse(options.since) : Number.NEGATIVE_INFINITY;
  const untilMs = options.until ? Date.parse(options.until) : Number.POSITIVE_INFINITY;

  const costed: Array<{ entry: CostLedgerEntry; cost: number }> = [];
  const resourceUsageEntries: CostLedgerEntry[] = [];
  for (const entry of entries) {
    const at = Date.parse(String(entry.timestamp || ''));
    if (!Number.isFinite(at) || at < sinceMs || at > untilMs) continue;
    if (entry.type === 'resource_usage') resourceUsageEntries.push(entry);
    const cost = effectiveCostUsd(entry);
    if (cost <= 0) continue;
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
  };
}

export function buildCostReportFromHistory(
  options: { since?: string; until?: string } = {}
): CostReport {
  return buildCostReport(
    [
      ...(metrics.loadHistory() as CostLedgerEntry[]),
      ...(metrics.loadResourceUsageHistory() as CostLedgerEntry[]),
    ],
    options
  );
}

export function formatCostReport(report: CostReport, topN = 5): string[] {
  const lines: string[] = [
    `Cost report${report.since ? ` since ${report.since}` : ''}: ` +
      `$${report.total_usd.toFixed(4)} across ${report.calls} call(s)` +
      (report.estimated_usd > 0 ? ` (incl. ~$${report.estimated_usd.toFixed(4)} estimated)` : ''),
  ];
  const section = (title: string, buckets: CostBucket[]) => {
    lines.push(`${title}:`);
    for (const bucket of buckets.slice(0, topN)) {
      lines.push(
        `  ${bucket.key}: $${bucket.cost_usd.toFixed(4)} ` +
          `(${bucket.calls} calls, ${bucket.prompt_tokens}+${bucket.completion_tokens} tokens)`
      );
    }
    if (buckets.length === 0) lines.push('  (none)');
  };
  section('By mission', report.by_mission);
  section('By model', report.by_model);
  section('By day', report.by_day);
  return lines;
}
