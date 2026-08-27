import { createHash } from 'node:crypto';
import * as path from 'node:path';
import {
  eventScopeMatches,
  normalizeEventScope,
  type EventScope,
  type EventScopeFilter,
  type EventScopeInput,
} from './event-scope.js';
import { metrics, MetricsCollector } from './metrics.js';
import { pathResolver } from './path-resolver.js';
import { physicalScopedPath } from './physical-namespace.js';
import { withLockSync } from './src/lock-utils.js';
import { readJson } from './foundation/json.js';
import { safeExistsSync, safeMkdir, safeReaddir, safeStat, safeWriteFile } from './secure-io.js';

export const GENERATION_COST_SETTLEMENT_ROOT =
  'active/shared/runtime/media-generation/cost-settlements';

export type GenerationCostSettlementStatus = 'settled' | 'unavailable';

export interface GenerationCostSettlement {
  kind: 'generation-cost-settlement';
  settlement_id: string;
  job_id: string;
  action: string;
  provider?: string;
  backend_id?: string;
  status: GenerationCostSettlementStatus;
  currency: 'USD';
  actual_cost_usd?: number;
  scope: EventScope;
  observed_at: string;
  source: 'provider-reported';
  resource_usage_recorded?: boolean;
}

export interface GenerationCostSettlementJob {
  job_id: string;
  action: string;
  status: string;
  scope?: EventScopeInput;
  provider?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

export interface SettleGenerationProviderCostOptions {
  now?: Date;
  metricsCollector?: MetricsCollector;
  rootDir?: string;
}

function settlementFile(
  jobId: string,
  scope: EventScope,
  rootDir = pathResolver.rootDir()
): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(jobId)) {
    throw new Error(`[GENERATION_COST_JOB_ID_INVALID] invalid job_id '${jobId}'`);
  }
  return path.join(
    rootDir,
    physicalScopedPath(GENERATION_COST_SETTLEMENT_ROOT, scope, `${jobId}.json`)
  );
}

function lockId(jobId: string, scope: EventScope): string {
  const key = JSON.stringify({ jobId, scope });
  return `generation-cost-settlement-${createHash('sha256').update(key).digest('hex')}`;
}

function finiteNonNegative(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function recordValue(record: Record<string, unknown> | undefined, key: string): unknown {
  return record && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/**
 * Extract only provider-reported actuals. Estimate fields are intentionally
 * excluded so an absent provider invoice never becomes a false actual cost.
 */
export function extractProviderReportedCost(job: GenerationCostSettlementJob): number | undefined {
  const result = job.result;
  const provider = job.provider;
  const providerMetadata = recordValue(result, 'provider_metadata');
  const metadata =
    providerMetadata && typeof providerMetadata === 'object' && !Array.isArray(providerMetadata)
      ? (providerMetadata as Record<string, unknown>)
      : undefined;
  const candidates = [
    recordValue(result, 'actual_cost_usd'),
    recordValue(result, 'provider_cost_usd'),
    recordValue(result, 'cost_usd'),
    recordValue(result, 'total_cost_usd'),
    recordValue(metadata, 'actual_cost_usd'),
    recordValue(metadata, 'provider_cost_usd'),
    recordValue(metadata, 'cost_usd'),
    recordValue(metadata, 'total_cost_usd'),
    recordValue(provider, 'actual_cost_usd'),
    recordValue(provider, 'provider_cost_usd'),
    recordValue(provider, 'cost_usd'),
    recordValue(provider, 'total_cost_usd'),
  ];
  return candidates.map(finiteNonNegative).find((value): value is number => value !== undefined);
}

function readSettlement(filePath: string): GenerationCostSettlement | undefined {
  if (!safeExistsSync(filePath)) return undefined;
  try {
    const parsed = readJson<GenerationCostSettlement>(filePath);
    if (
      parsed?.kind !== 'generation-cost-settlement' ||
      typeof parsed.job_id !== 'string' ||
      !parsed.scope ||
      (parsed.status !== 'settled' && parsed.status !== 'unavailable')
    ) {
      return undefined;
    }
    return { ...parsed, scope: normalizeEventScope(parsed.scope) };
  } catch {
    return undefined;
  }
}

function writeSettlement(filePath: string, settlement: GenerationCostSettlement): void {
  safeMkdir(path.dirname(filePath), { recursive: true });
  safeWriteFile(filePath, JSON.stringify(settlement, null, 2));
}

export function settleGenerationProviderCost(
  job: GenerationCostSettlementJob,
  options: SettleGenerationProviderCostOptions = {}
): GenerationCostSettlement {
  const scope = normalizeEventScope(job.scope || { scope_kind: 'system', tier: 'public' });
  const filePath = settlementFile(job.job_id, scope, options.rootDir);
  const now = (options.now || new Date()).toISOString();
  const actualCost = extractProviderReportedCost(job);
  const existing = readSettlement(filePath);
  if (existing && actualCost === undefined) return existing;

  return withLockSync(lockId(job.job_id, scope), () => {
    const lockedExisting = readSettlement(filePath);
    if (lockedExisting && actualCost === undefined) return lockedExisting;

    const settlement: GenerationCostSettlement = {
      kind: 'generation-cost-settlement',
      settlement_id: `generation:${job.job_id}`,
      job_id: job.job_id,
      action: job.action,
      ...(typeof job.provider?.engine === 'string' ? { provider: job.provider.engine } : {}),
      ...(typeof job.result?.backend_id === 'string' ? { backend_id: job.result.backend_id } : {}),
      status: actualCost === undefined ? 'unavailable' : 'settled',
      currency: 'USD',
      ...(actualCost === undefined ? {} : { actual_cost_usd: actualCost }),
      scope,
      observed_at: now,
      source: 'provider-reported',
    };

    if (actualCost !== undefined) {
      const usageId = `generation-provider-cost:${job.job_id}`;
      const collector = options.metricsCollector || metrics;
      const alreadyRecorded = collector
        .loadResourceUsageHistory()
        .some((entry) => entry.usage_id === usageId);
      if (!alreadyRecorded) {
        try {
          collector.recordResourceUsage({
            usage_id: usageId,
            resource_kind: 'saas',
            actor_id: job.provider?.engine as string | undefined,
            quantity: 1,
            unit: 'generation_job',
            unit_cost_usd: actualCost,
            cost_usd: actualCost,
            status: 'actual',
            source: 'media-generation-provider',
            scope,
            metadata: {
              settlement_id: settlement.settlement_id,
              job_id: job.job_id,
              action: job.action,
              provider: job.provider?.engine,
              backend_id: job.result?.backend_id,
            },
          });
          settlement.resource_usage_recorded = true;
        } catch {
          settlement.resource_usage_recorded = false;
        }
      } else {
        settlement.resource_usage_recorded = true;
      }
    }

    writeSettlement(filePath, settlement);
    return settlement;
  });
}

function settlementFiles(root: string): string[] {
  if (!safeExistsSync(root)) return [];
  return safeReaddir(root).flatMap((entry) => {
    const entryPath = path.join(root, entry);
    if (entry === '.quarantine') return [];
    const stat = safeStat(entryPath);
    if (stat.isFile() && entry.endsWith('.json')) return [entryPath];
    if (stat.isDirectory()) return settlementFiles(entryPath);
    return [];
  });
}

export function listGenerationCostSettlements(
  options: {
    scopeFilter?: EventScopeFilter;
    since?: string;
    rootDir?: string;
  } = {}
): GenerationCostSettlement[] {
  const root = path.join(
    options.rootDir || pathResolver.rootDir(),
    GENERATION_COST_SETTLEMENT_ROOT
  );
  const seen = new Map<string, GenerationCostSettlement>();
  for (const filePath of settlementFiles(root)) {
    const settlement = readSettlement(filePath);
    if (!settlement) continue;
    if (options.since && settlement.observed_at < options.since) continue;
    if (options.scopeFilter && !eventScopeMatches(settlement.scope, options.scopeFilter)) continue;
    const prior = seen.get(settlement.settlement_id);
    if (!prior || prior.observed_at < settlement.observed_at)
      seen.set(settlement.settlement_id, settlement);
  }
  return Array.from(seen.values()).sort((left, right) =>
    left.observed_at.localeCompare(right.observed_at)
  );
}
