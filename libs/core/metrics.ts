import { appendJsonLine, readJson, readJsonLines } from './foundation/json.js';
import { assertSafeRepositoryPath, safeMkdir, safeExistsSync } from './secure-io.js';
import * as pathResolver from './path-resolver.js';
import * as path from 'node:path';
import chalk from 'chalk';
import { createLogger } from './logger.js';
import { normalizeEventScope, type EventScope, type EventScopeInput } from './event-scope.js';
import { normalizeUsageCause, type UsageCause } from './usage-accounting.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { clamp } from './foundation/text.js';
import { nowIso } from './foundation/time.js';
const logger = createLogger('metrics');

/**
 * Lightweight metrics collection for Kyberion.
 * Standardized with Secure-IO.
 */

const DEFAULT_METRICS_DIR = pathResolver.resolve('work/metrics');
const DEFAULT_METRICS_FILE = 'execution-metrics.jsonl';
const DEFAULT_RESOURCE_USAGE_FILE = 'resource-usage.jsonl';
const DEFAULT_MEMORY_BUDGET_MB = 200;

export interface CostRate {
  prompt: number;
  completion: number;
  cache_read?: number;
  cache_write?: number;
  cache_write_1h?: number;
}
export interface CostTier extends CostRate {
  /** Inclusive input-token threshold for this rate, stored per 1k tokens. */
  input_tokens_above: number;
}
export interface ModelCostEntry extends CostRate {
  tiers?: CostTier[];
}
export interface ModelCostRegistry {
  models: Record<string, ModelCostEntry>;
  aliases?: Record<string, string>;
  default: ModelCostEntry;
}

interface ModelCostRegistryFile extends ModelCostRegistry {
  version: string;
  currency: string;
  unit: string;
  note?: string;
}

// Model pricing is data, not code: it lives in a knowledge-tier registry so models
// can be added / repriced without a source change or redeploy. The file is the
// source of truth; the fallback file keeps the runtime working when the primary
// registry is missing or malformed. All rates are per-1k tokens.
const COST_REGISTRY_PATH = pathResolver.resolve(
  'knowledge/product/governance/model-cost-registry.json'
);
const FALLBACK_COST_REGISTRY_PATH = pathResolver.resolve(
  'knowledge/product/governance/model-cost-registry.fallback.json'
);
const COST_REGISTRY_SCHEMA_PATH = pathResolver.resolve(
  'knowledge/product/schemas/model-cost-registry.schema.json'
);
const EMPTY_COST_REGISTRY: ModelCostRegistry = {
  models: {},
  aliases: {},
  default: { prompt: 0.001, completion: 0.003 },
};

let _cachedCostRegistry: ModelCostRegistry | null = null;

const primaryCostRegistryCatalog = defineCatalog<ModelCostRegistryFile>({
  id: 'model-cost-registry',
  path: COST_REGISTRY_PATH,
  schema: COST_REGISTRY_SCHEMA_PATH,
});

const fallbackCostRegistryCatalog = defineCatalog<ModelCostRegistryFile>({
  id: 'model-cost-registry-fallback',
  path: FALLBACK_COST_REGISTRY_PATH,
  schema: COST_REGISTRY_SCHEMA_PATH,
});

function readCostRegistry(filePath: string): ModelCostRegistry | null {
  try {
    if (!safeExistsSync(filePath)) return null;
    const catalog =
      filePath === COST_REGISTRY_PATH ? primaryCostRegistryCatalog : fallbackCostRegistryCatalog;
    const parsed = catalog.load();
    return { models: parsed.models, aliases: parsed.aliases ?? {}, default: parsed.default };
  } catch {
    /* ignore */
  }
  return null;
}

/** Load (and cache) the model-cost registry from the knowledge tier, with fallback. */
export function loadModelCostRegistry(): ModelCostRegistry {
  if (_cachedCostRegistry) return _cachedCostRegistry;
  const fallback = readCostRegistry(FALLBACK_COST_REGISTRY_PATH);
  const primary = readCostRegistry(COST_REGISTRY_PATH);
  if (fallback || primary) {
    _cachedCostRegistry = {
      models: {
        ...(fallback?.models ?? {}),
        ...(primary?.models ?? {}),
      },
      aliases: {
        ...(fallback?.aliases ?? {}),
        ...(primary?.aliases ?? {}),
      },
      default: primary?.default ?? fallback?.default ?? EMPTY_COST_REGISTRY.default,
    };
    return _cachedCostRegistry;
  }
  _cachedCostRegistry = EMPTY_COST_REGISTRY;
  return _cachedCostRegistry;
}

/** Test/hot-reload hook: drop the cached registry so the next call re-reads the file. */
export function _resetModelCostRegistryCacheForTests(): void {
  _cachedCostRegistry = null;
  primaryCostRegistryCatalog.reset();
  fallbackCostRegistryCatalog.reset();
}

function selectTier(entry: ModelCostEntry, inputTokens: number): CostRate {
  if (!entry.tiers?.length) return entry;
  const threshold = Number.isFinite(inputTokens) && inputTokens >= 0 ? inputTokens : 0;
  return (
    [...entry.tiers]
      .filter((tier) => tier.input_tokens_above <= threshold)
      .sort((left, right) => right.input_tokens_above - left.input_tokens_above)[0] ?? entry
  );
}

function resolvePer1kRate(reg: ModelCostRegistry, model: string, inputTokens: number): CostRate {
  const id = (model || '').trim();
  if (!id) return selectTier(reg.default, inputTokens);
  if (reg.models[id]) return selectTier(reg.models[id], inputTokens);
  if (reg.aliases?.[id] && reg.models[reg.aliases[id]])
    return selectTier(reg.models[reg.aliases[id]], inputTokens);
  // Versioned ids never exact-match; take the longest model-id or alias contained in the given id.
  const lower = id.toLowerCase();
  const candidates = [...Object.keys(reg.models), ...Object.keys(reg.aliases ?? {})].sort(
    (a, b) => b.length - a.length
  );
  for (const key of candidates) {
    if (lower.includes(key.toLowerCase())) {
      const target = reg.models[key] ? key : reg.aliases?.[key];
      if (target && reg.models[target]) return selectTier(reg.models[target], inputTokens);
    }
  }
  return selectTier(reg.default, inputTokens);
}

/**
 * Resolve per-TOKEN rates for a model id from the knowledge-tier cost registry.
 * Registry stores per-1k rates; returned rates are per-token (÷1000) for direct
 * multiplication by token counts in `record()`.
 */
export function resolveCostRatesFromRegistry(
  registry: ModelCostRegistry,
  model: string,
  inputTokens = 0
): CostRate {
  const perK = resolvePer1kRate(registry, model, inputTokens);
  return {
    prompt: perK.prompt / 1000,
    completion: perK.completion / 1000,
    ...(perK.cache_read === undefined ? {} : { cache_read: perK.cache_read / 1000 }),
    ...(perK.cache_write === undefined ? {} : { cache_write: perK.cache_write / 1000 }),
    ...(perK.cache_write_1h === undefined ? {} : { cache_write_1h: perK.cache_write_1h / 1000 }),
  };
}

export function resolveCostRates(model: string, inputTokens = 0): CostRate {
  return resolveCostRatesFromRegistry(loadModelCostRegistry(), model, inputTokens);
}

export interface MetricsOptions {
  metricsDir?: string;
  metricsFile?: string;
  persist?: boolean;
  memoryBudgetMB?: number;
  resourceUsageFile?: string;
  /** Optional injected registry for deterministic tests or an isolated runtime. */
  costRegistry?: ModelCostRegistry;
}

export type ResourceUsageKind = 'llm' | 'api' | 'compute' | 'saas' | 'human_time' | 'other';
export type ResourceUsageStatus = 'actual' | 'estimated' | 'committed';

export interface ResourceUsageRecord {
  type: 'resource_usage';
  usage_id: string;
  timestamp: string;
  resource_kind: ResourceUsageKind;
  actor_id?: string;
  mission_id?: string;
  customer_id?: string;
  cost_center?: string;
  quantity: number;
  unit: string;
  unit_cost_usd?: number;
  cost_usd: number;
  status: ResourceUsageStatus;
  source: string;
  /** Canonical containment scope; legacy records may omit it. */
  scope?: EventScope;
  metadata?: Record<string, unknown>;
  cause?: UsageCause;
}

export class MetricsCollector {
  private _metricsDir: string;
  private _metricsFile: string;
  private _persist: boolean;
  private _memoryBudgetMB: number;
  private _resourceUsageFile: string;
  private _costRegistry?: ModelCostRegistry;
  private _aggregates: Map<string, any>;

  constructor(options: MetricsOptions = {}) {
    this._metricsDir = assertSafeRepositoryPath(options.metricsDir || DEFAULT_METRICS_DIR, {
      allowMissingLeaf: true,
    });
    this._metricsFile = options.metricsFile || DEFAULT_METRICS_FILE;
    this._persist = options.persist !== false;
    this._memoryBudgetMB = options.memoryBudgetMB || DEFAULT_MEMORY_BUDGET_MB;
    this._resourceUsageFile = options.resourceUsageFile || DEFAULT_RESOURCE_USAGE_FILE;
    this._costRegistry = options.costRegistry;
    this._aggregates = new Map();
  }

  private _metricsPath(fileName: string): string {
    return assertSafeRepositoryPath(path.join(this._metricsDir, fileName), {
      allowMissingLeaf: true,
    });
  }

  /** Append a normalized, actor-neutral resource usage ledger entry. */
  recordResourceUsage(
    input: Omit<ResourceUsageRecord, 'type' | 'usage_id' | 'timestamp' | 'cost_usd' | 'scope'> & {
      usage_id?: string;
      timestamp?: string;
      cost_usd?: number;
      scope?: EventScopeInput;
    }
  ): ResourceUsageRecord {
    const quantity = Number(input.quantity);
    if (!Number.isFinite(quantity) || quantity < 0) {
      throw new Error('resource usage quantity must be a finite non-negative number');
    }
    const unitCost = input.unit_cost_usd === undefined ? undefined : Number(input.unit_cost_usd);
    if (unitCost !== undefined && (!Number.isFinite(unitCost) || unitCost < 0)) {
      throw new Error('resource usage unit_cost_usd must be a finite non-negative number');
    }
    const explicitCost = input.cost_usd === undefined ? undefined : Number(input.cost_usd);
    const cost = explicitCost ?? (unitCost === undefined ? 0 : quantity * unitCost);
    if (!Number.isFinite(cost) || cost < 0) {
      throw new Error('resource usage cost_usd must be a finite non-negative number');
    }
    const missionId = input.mission_id || process.env.MISSION_ID || undefined;
    const scope = input.scope ? normalizeEventScope(input.scope) : undefined;
    const record: ResourceUsageRecord = {
      type: 'resource_usage',
      usage_id:
        input.usage_id || `${input.resource_kind}:${input.actor_id || 'unknown'}:${Date.now()}`,
      timestamp: input.timestamp || nowIso(),
      resource_kind: input.resource_kind,
      actor_id: input.actor_id,
      mission_id: missionId,
      customer_id: input.customer_id,
      cost_center: input.cost_center,
      quantity,
      unit: input.unit,
      unit_cost_usd: unitCost,
      cost_usd: Math.round(cost * 100000) / 100000,
      status: input.status,
      source: input.source,
      cause: normalizeUsageCause(input.cause),
      ...(scope ? { scope } : {}),
      metadata: input.metadata,
    };
    if (this._persist) this._appendResourceUsage(record);
    return record;
  }

  record(componentName: string, durationMs: number, status: 'success' | 'error', extra: any = {}) {
    const mem = process.memoryUsage();
    const memory = {
      heapUsedMB: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
      heapTotalMB: Math.round((mem.heapTotal / 1024 / 1024) * 100) / 100,
      rssMB: Math.round((mem.rss / 1024 / 1024) * 100) / 100,
    };

    if (memory.heapUsedMB > this._memoryBudgetMB) {
      logger.warn(
        chalk.yellow(
          `[${componentName}] Memory budget exceeded: ${memory.heapUsedMB}MB (Budget: ${this._memoryBudgetMB}MB)`
        )
      );
    }

    let agg = this._aggregates.get(componentName);
    if (!agg) {
      agg = {
        count: 0,
        errors: 0,
        totalMs: 0,
        minMs: Infinity,
        maxMs: 0,
        lastRun: '',
        peakHeapMB: 0,
        peakRssMB: 0,
        cacheHits: 0,
        cacheMisses: 0,
        cachePurges: 0,
        recoveries: 0,
        interventions: 0,
        totalCostUSD: 0,
        cacheIntegrityFailures: 0,
        outputSizeKB: 0,
        promptTokens: 0,
        completionTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0,
        totalTokens: 0,
      };
      this._aggregates.set(componentName, agg);
    }
    agg.count++;
    if (status === 'error') agg.errors++;
    if (extra.recovered) agg.recoveries++;
    if (extra.intervention) agg.interventions++;

    agg.totalMs += durationMs;
    agg.minMs = Math.min(agg.minMs, durationMs);
    agg.maxMs = Math.max(agg.maxMs, durationMs);
    agg.lastRun = nowIso();
    agg.peakHeapMB = Math.max(agg.peakHeapMB, memory.heapUsedMB);
    agg.peakRssMB = Math.max(agg.peakRssMB, memory.rssMB);

    if (extra.usage) {
      const pTokens = extra.usage.prompt_tokens || 0;
      const cTokens = extra.usage.completion_tokens || 0;
      const cacheReadTokens =
        extra.usage.cache_read_tokens ?? extra.usage.cache_read_input_tokens ?? 0;
      const cacheWriteTokens =
        extra.usage.cache_write_tokens ?? extra.usage.cache_creation_input_tokens ?? 0;
      const cacheWrite1hTokens = extra.usage.cache_write_1h_tokens ?? 0;
      const inputTokens = pTokens + cacheReadTokens + cacheWriteTokens + cacheWrite1hTokens;
      agg.promptTokens += pTokens;
      agg.completionTokens += cTokens;
      agg.cacheReadTokens += cacheReadTokens;
      agg.cacheWriteTokens += cacheWriteTokens;
      agg.cacheWrite1hTokens += cacheWrite1hTokens;
      agg.totalTokens += inputTokens + cTokens;

      const model = extra.model || 'default';
      const rates = resolveCostRatesFromRegistry(
        this._costRegistry ?? loadModelCostRegistry(),
        model,
        inputTokens
      );
      const cost =
        pTokens * rates.prompt +
        cTokens * rates.completion +
        cacheReadTokens * (rates.cache_read ?? 0) +
        cacheWriteTokens * (rates.cache_write ?? 0) +
        cacheWrite1hTokens * (rates.cache_write_1h ?? 0);
      agg.totalCostUSD += cost;
      extra.cost_usd = Math.round(cost * 100000) / 100000;
    }

    if (extra.outputSize) {
      agg.outputSizeKB = Math.max(agg.outputSizeKB, Math.round(extra.outputSize / 1024));
    }

    if (extra.cacheStats) {
      agg.cacheHits += extra.cacheStats.hits || 0;
      agg.cacheMisses += extra.cacheStats.misses || 0;
      agg.cachePurges += extra.cacheStats.purges || 0;
      agg.cacheIntegrityFailures += extra.cacheStats.integrityFailures || 0;
    }

    const missionId = extra.mission_id || process.env.MISSION_ID || undefined;
    const persistedExtra = {
      ...extra,
      cause: normalizeUsageCause(extra.cause),
      ...(missionId ? { mission_id: missionId } : {}),
    };

    if (this._persist) {
      this._appendToFile({
        component: componentName,
        duration_ms: durationMs,
        status,
        timestamp: agg.lastRun,
        memory,
        ...persistedExtra,
      });
    }
  }

  recordIntervention(context: string, decisionId: string) {
    this._appendToFile({
      type: 'intervention',
      context,
      decision: decisionId,
      timestamp: nowIso(),
    });
  }

  summarize() {
    const summaries: any[] = [];
    const TIME_BASE = 5000;
    const MEM_BASE = 200;

    for (const [name, agg] of this._aggregates) {
      const avgMs = agg.count > 0 ? Math.round(agg.totalMs / agg.count) : 0;
      const totalCache = agg.cacheHits + agg.cacheMisses;
      const cacheRatio = totalCache > 0 ? agg.cacheHits / totalCache : 0;

      const timeImpact = Math.min(40, (avgMs / TIME_BASE) * 40);
      const memImpact = Math.min(40, (agg.peakHeapMB / MEM_BASE) * 40);
      const cacheBonus = Math.round(cacheRatio * 20);
      const purgePenalty = Math.min(20, (agg.cachePurges || 0) * 5);

      const efficiencyScore = Math.max(
        0,
        Math.min(100, Math.round(100 - (timeImpact + memImpact) + cacheBonus - purgePenalty))
      );

      summaries.push({
        component: name,
        executions: agg.count,
        errors: agg.errors,
        errorRate: agg.count > 0 ? Math.round((agg.errors / agg.count) * 1000) / 10 : 0,
        avgMs,
        minMs: agg.minMs === Infinity ? 0 : agg.minMs,
        maxMs: agg.maxMs,
        lastRun: agg.lastRun,
        peakHeapMB: agg.peakHeapMB,
        peakRssMB: agg.peakRssMB,
        efficiencyScore,
        cacheHitRatio: Math.round(cacheRatio * 100),
        cachePurges: agg.cachePurges || 0,
        recoveries: agg.recoveries || 0,
        recoveryRate: agg.count > 0 ? Math.round((agg.recoveries / agg.count) * 1000) / 10 : 0,
        cacheIntegrityFailures: agg.cacheIntegrityFailures || 0,
        outputSizeKB: agg.outputSizeKB || 0,
        avgTokens: agg.count > 0 ? Math.round(agg.totalTokens / agg.count) : 0,
        totalTokens: agg.totalTokens,
        cacheReadTokens: agg.cacheReadTokens,
        cacheWriteTokens: agg.cacheWriteTokens,
        cacheWrite1hTokens: agg.cacheWrite1hTokens,
        totalCostUSD: Math.round(agg.totalCostUSD * 1000) / 1000,
        interventions: agg.interventions || 0,
        interventionRate: agg.count > 0 ? Math.round((agg.interventions / agg.count) * 100) : 0,
      });
    }
    return summaries.sort((a, b) => b.executions - a.executions);
  }

  getSkillMetrics(skillName: string) {
    return this._aggregates.get(skillName) || null;
  }

  getCapabilityMetrics(capabilityName: string) {
    return this._aggregates.get(capabilityName) || null;
  }

  loadHistory() {
    try {
      const filePath = this._metricsPath(this._metricsFile);
      if (!safeExistsSync(filePath)) return [];
      return readJsonLines<Record<string, any>>(assertSafeRepositoryPath(filePath));
    } catch (_) {
      return [];
    }
  }

  loadResourceUsageHistory(): ResourceUsageRecord[] {
    try {
      const filePath = this._metricsPath(this._resourceUsageFile);
      if (!safeExistsSync(filePath)) return [];
      return readJsonLines<ResourceUsageRecord>(assertSafeRepositoryPath(filePath));
    } catch {
      return [];
    }
  }

  reportFromHistory() {
    const entries = this.loadHistory();
    const bySkill: Record<string, any> = {};
    const sloPathCandidates = [
      pathResolver.resolve('knowledge/product/orchestration/slo-targets.json'),
      pathResolver.resolve('knowledge/orchestration/slo-targets.json'),
    ];
    let sloTargets: {
      critical_path?: Record<string, { latency_ms: number }>;
      default: { latency_ms: number };
    } = { default: { latency_ms: 5000 } };
    for (const candidate of sloPathCandidates) {
      try {
        const safeCandidate = assertSafeRepositoryPath(candidate);
        if (!safeExistsSync(safeCandidate)) continue;
        sloTargets = readJson<{
          critical_path?: Record<string, { latency_ms: number }>;
          default: { latency_ms: number };
        }>(assertSafeRepositoryPath(safeCandidate));
        break;
      } catch {
        // A malformed or symlinked optional SLO registry must not escape its scope.
      }
    }

    for (const entry of entries) {
      const componentName = entry.component || entry.skill || entry.capability;
      if (!componentName) continue;
      if (!bySkill[componentName]) {
        bySkill[componentName] = {
          count: 0,
          errors: 0,
          totalMs: 0,
          minMs: Infinity,
          maxMs: 0,
          cacheHits: 0,
          cacheMisses: 0,
          sloPasses: 0,
        };
      }
      const s = bySkill[componentName];
      s.count++;
      if (entry.status === 'error') s.errors++;
      s.totalMs += entry.duration_ms || 0;
      s.minMs = Math.min(s.minMs, entry.duration_ms || 0);
      s.maxMs = Math.max(s.maxMs, entry.duration_ms || 0);

      const target =
        (sloTargets.critical_path && sloTargets.critical_path[componentName]) || sloTargets.default;
      const isLatencyOk = (entry.duration_ms || 0) <= target.latency_ms;
      if (isLatencyOk && entry.status !== 'error') s.sloPasses++;

      if (entry.cacheStats) {
        s.cacheHits += entry.cacheStats.hits || 0;
        s.cacheMisses += entry.cacheStats.misses || 0;
      }
    }

    const skills = Object.entries(bySkill).map(([name, s]) => {
      const avgMs = s.count > 0 ? Math.round(s.totalMs / s.count) : 0;
      const totalCache = s.cacheHits + s.cacheMisses;
      const cacheHitRatio = totalCache > 0 ? Math.round((s.cacheHits / totalCache) * 100) : 0;
      const sloCompliance = s.count > 0 ? Math.round((s.sloPasses / s.count) * 100) : 0;

      let manualMs = 300000;
      if (name.includes('audit') || name.includes('scan') || name.includes('check'))
        manualMs = 900000;
      else if (name.includes('generate') || name.includes('create') || name.includes('artisan'))
        manualMs = 1800000;
      else if (name.includes('analyze') || name.includes('optimize')) manualMs = 3600000;

      const savedMs = Math.max(0, manualMs * s.count - s.totalMs);
      const savedCost = Math.round((savedMs / 3600000) * 100);

      const TIME_BASE = 5000;
      const timeImpact = Math.min(50, (avgMs / TIME_BASE) * 50);
      const cacheBonus = Math.round((cacheHitRatio / 100) * 20);
      const efficiencyScore = clamp(Math.round(100 - timeImpact + cacheBonus), 0, 100);

      return {
        component: name,
        skill: name,
        executions: s.count,
        errors: s.errors,
        errorRate: s.count > 0 ? Math.round((s.errors / s.count) * 1000) / 10 : 0,
        avgMs,
        minMs: s.minMs === Infinity ? 0 : s.minMs,
        maxMs: s.maxMs,
        cacheHitRatio,
        sloCompliance,
        efficiencyScore,
        manualMs,
        savedMs,
        savedCost,
      };
    });

    return {
      totalEntries: entries.length,
      uniqueSkills: skills.length,
      dateRange:
        entries.length > 0
          ? { from: entries[0].timestamp, to: entries[entries.length - 1].timestamp }
          : null,
      skills: skills.sort((a, b) => b.executions - a.executions),
    };
  }

  detectRegressions(thresholdMultiplier = 1.5) {
    const entries = this.loadHistory();
    const bySkill: Record<string, any[]> = {};
    for (const entry of entries) {
      if (!bySkill[entry.skill]) bySkill[entry.skill] = [];
      bySkill[entry.skill].push(entry);
    }

    const regressions: any[] = [];
    for (const [name, runs] of Object.entries(bySkill)) {
      if (runs.length < 5) continue;
      const lastRun = runs[runs.length - 1];
      const history = runs.slice(0, -1);
      const avgMs = history.reduce((sum, r) => sum + (r.duration_ms || 0), 0) / history.length;

      if (lastRun.duration_ms > avgMs * thresholdMultiplier) {
        regressions.push({
          skill: name,
          lastDuration: lastRun.duration_ms,
          historicalAvg: Math.round(avgMs),
          increaseRate: Math.round((lastRun.duration_ms / avgMs) * 10) / 10,
          timestamp: lastRun.timestamp,
        });
      }
    }
    return regressions;
  }

  reset() {
    this._aggregates.clear();
  }

  private _appendToFile(entry: any) {
    try {
      const metricsDir = assertSafeRepositoryPath(this._metricsDir, { allowMissingLeaf: true });
      if (!safeExistsSync(metricsDir)) {
        safeMkdir(metricsDir, { recursive: true });
      }
      const filePath = this._metricsPath(this._metricsFile);
      appendJsonLine(filePath, entry);
    } catch (err) {
      logger.warn(`suppressed error in _appendToFile: ${err}`);
    }
  }

  private _appendResourceUsage(entry: ResourceUsageRecord) {
    try {
      const metricsDir = assertSafeRepositoryPath(this._metricsDir, { allowMissingLeaf: true });
      if (!safeExistsSync(metricsDir)) safeMkdir(metricsDir, { recursive: true });
      appendJsonLine(this._metricsPath(this._resourceUsageFile), entry);
    } catch (_) {
      /* metrics are best-effort and must not block the operation */
    }
  }
}

export const metrics = new MetricsCollector();
