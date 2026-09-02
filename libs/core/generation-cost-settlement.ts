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
import { defineCatalog } from './foundation/governed-catalog.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeLstat,
  safeWriteFile,
} from './secure-io.js';

export const GENERATION_COST_SETTLEMENT_ROOT =
  'active/shared/runtime/media-generation/cost-settlements';

const GENERATION_COST_SETTLEMENT_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/generation-cost-settlement.schema.json'
);

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

const generationCostSettlementCatalog = defineCatalog<GenerationCostSettlement>({
  id: 'generation-cost-settlement',
  path: GENERATION_COST_SETTLEMENT_SCHEMA_PATH,
  schema: GENERATION_COST_SETTLEMENT_SCHEMA_PATH,
});

function settlementFile(
  jobId: string,
  scope: EventScope,
  rootDir = pathResolver.rootDir()
): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(jobId)) {
    throw new Error(`[GENERATION_COST_JOB_ID_INVALID] invalid job_id '${jobId}'`);
  }
  return assertSafeRepositoryPath(
    path.join(
      assertSafeRepositoryPath(rootDir, { allowMissingLeaf: true }),
      physicalScopedPath(GENERATION_COST_SETTLEMENT_ROOT, scope, `${jobId}.json`)
    ),
    { allowMissingLeaf: true }
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

function scopesEqual(left: EventScope, right: EventScope): boolean {
  const keys: Array<keyof EventScope> = [
    'scope_kind',
    'tier',
    'tenant_slug',
    'organization_id',
    'project_id',
    'mission_id',
    'task_id',
    'session_id',
    'work_shape',
    'customer_stance',
    'viewer_principal',
    'nhi_id',
  ];
  return keys.every((key) => left[key] === right[key]);
}

function parseSettlement(
  value: unknown,
  filePath: string,
  options: { jobId?: string; scope?: EventScope; rootDir?: string } = {}
): GenerationCostSettlement {
  const parsed = generationCostSettlementCatalog.validate(value, filePath);
  const fileJobId = path.basename(filePath, '.json');
  if (parsed.job_id !== fileJobId || parsed.settlement_id !== `generation:${parsed.job_id}`) {
    throw new Error('generation cost settlement job binding mismatch');
  }
  if (options.jobId && parsed.job_id !== options.jobId) {
    throw new Error('generation cost settlement job scope mismatch');
  }
  const scope = normalizeEventScope(parsed.scope);
  if (options.scope && !scopesEqual(scope, options.scope)) {
    throw new Error('generation cost settlement scope mismatch');
  }
  const expectedPath = settlementFile(
    parsed.job_id,
    scope,
    options.rootDir ?? pathResolver.rootDir()
  );
  if (path.resolve(expectedPath) !== path.resolve(filePath)) {
    throw new Error('generation cost settlement physical scope mismatch');
  }
  return { ...parsed, scope };
}

/** Load a settlement through schema, regular-file, job, and scope binding checks. */
export function loadGenerationCostSettlementAtPath(
  filePath: string,
  options: { jobId?: string; scope?: EventScope; rootDir?: string } = {}
): GenerationCostSettlement {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (!safeLstat(safeFilePath).isFile()) {
    throw new Error(`[GENERATION_COST_SETTLEMENT] settlement must be a regular file: ${filePath}`);
  }
  return parseSettlement(readJson<unknown>(safeFilePath), safeFilePath, options);
}

function readSettlement(
  filePath: string,
  options: { jobId?: string; scope?: EventScope; rootDir?: string } = {}
): GenerationCostSettlement | undefined {
  if (!safeExistsSync(filePath)) return undefined;
  try {
    return loadGenerationCostSettlementAtPath(filePath, options);
  } catch {
    return undefined;
  }
}

function writeSettlement(
  filePath: string,
  settlement: GenerationCostSettlement,
  rootDir?: string
): void {
  safeMkdir(path.dirname(filePath), { recursive: true });
  const validated = parseSettlement(settlement, filePath, { rootDir });
  safeWriteFile(filePath, JSON.stringify(validated, null, 2));
}

export function settleGenerationProviderCost(
  job: GenerationCostSettlementJob,
  options: SettleGenerationProviderCostOptions = {}
): GenerationCostSettlement {
  const scope = normalizeEventScope(job.scope || { scope_kind: 'system', tier: 'public' });
  const filePath = settlementFile(job.job_id, scope, options.rootDir);
  const now = (options.now || new Date()).toISOString();
  const actualCost = extractProviderReportedCost(job);
  const existing = readSettlement(filePath, { jobId: job.job_id, scope, rootDir: options.rootDir });
  if (existing && actualCost === undefined) return existing;

  return withLockSync(lockId(job.job_id, scope), () => {
    const lockedExisting = readSettlement(filePath, {
      jobId: job.job_id,
      scope,
      rootDir: options.rootDir,
    });
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

    writeSettlement(filePath, settlement, options.rootDir);
    return settlement;
  });
}

function settlementFiles(root: string): string[] {
  if (!safeExistsSync(root)) return [];
  return safeReaddir(root).flatMap((entry) => {
    const entryPath = path.join(root, entry);
    if (entry === '.quarantine') return [];
    const stat = safeLstat(entryPath);
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
  const root = assertSafeRepositoryPath(
    path.join(
      assertSafeRepositoryPath(options.rootDir || pathResolver.rootDir(), {
        allowMissingLeaf: true,
      }),
      GENERATION_COST_SETTLEMENT_ROOT
    ),
    { allowMissingLeaf: true }
  );
  const seen = new Map<string, GenerationCostSettlement>();
  for (const filePath of settlementFiles(root)) {
    const settlement = readSettlement(filePath, { rootDir: options.rootDir });
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
