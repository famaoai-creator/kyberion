import { 
  safeReadFile, 
  safeAppendFileSync, 
  safeMkdir, 
  safeExistsSync 
} from './secure-io.js';
import * as pathResolver from './path-resolver.js';
import * as path from 'node:path';
import chalk from 'chalk';

/**
 * Lightweight metrics collection for Kyberion.
 * Standardized with Secure-IO.
 */

const DEFAULT_METRICS_DIR = pathResolver.resolve('work/metrics');
const DEFAULT_METRICS_FILE = 'execution-metrics.jsonl';
const DEFAULT_MEMORY_BUDGET_MB = 200;

interface CostRate { prompt: number; completion: number }
interface ModelCostRegistry {
  models: Record<string, CostRate>;
  aliases?: Record<string, string>;
  default: CostRate;
}

// Model pricing is data, not code: it lives in a knowledge-tier registry so models
// can be added / repriced without a source change or redeploy. The file is the
// source of truth; this small built-in fallback is used only when it is
// absent/invalid. All rates are per-1k tokens.
const COST_REGISTRY_PATH = pathResolver.resolve('knowledge/product/governance/model-cost-registry.json');
const FALLBACK_COST_REGISTRY: ModelCostRegistry = {
  models: {
    'claude-opus-4-8': { prompt: 0.015, completion: 0.075 },
    'claude-sonnet-4-6': { prompt: 0.003, completion: 0.015 },
    'gpt-4o': { prompt: 0.005, completion: 0.015 },
  },
  aliases: { opus: 'claude-opus-4-8', sonnet: 'claude-sonnet-4-6' },
  default: { prompt: 0.001, completion: 0.003 },
};

let _cachedCostRegistry: ModelCostRegistry | null = null;

function isCostRate(value: any): value is CostRate {
  return value && typeof value.prompt === 'number' && typeof value.completion === 'number';
}

/** Load (and cache) the model-cost registry from the knowledge tier, with fallback. */
export function loadModelCostRegistry(): ModelCostRegistry {
  if (_cachedCostRegistry) return _cachedCostRegistry;
  try {
    if (safeExistsSync(COST_REGISTRY_PATH)) {
      const parsed = JSON.parse(safeReadFile(COST_REGISTRY_PATH, { encoding: 'utf8' }) as string);
      if (parsed && typeof parsed.models === 'object' && isCostRate(parsed.default)) {
        const models: Record<string, CostRate> = {};
        for (const [id, rate] of Object.entries(parsed.models)) {
          if (isCostRate(rate)) models[id] = rate as CostRate;
        }
        _cachedCostRegistry = { models, aliases: parsed.aliases ?? {}, default: parsed.default };
        return _cachedCostRegistry;
      }
    }
  } catch {
    // fall through to the built-in fallback
  }
  _cachedCostRegistry = FALLBACK_COST_REGISTRY;
  return _cachedCostRegistry;
}

/** Test/hot-reload hook: drop the cached registry so the next call re-reads the file. */
export function resetModelCostRegistryCache(): void {
  _cachedCostRegistry = null;
}

function resolvePer1kRate(reg: ModelCostRegistry, model: string): CostRate {
  const id = (model || '').trim();
  if (!id) return reg.default;
  if (reg.models[id]) return reg.models[id];
  if (reg.aliases?.[id] && reg.models[reg.aliases[id]]) return reg.models[reg.aliases[id]];
  // Versioned ids (claude-opus-4-8-YYYYMMDD, gemini-2.0-flash-exp) never exact-match:
  // take the longest model-id or alias contained in the given id.
  const lower = id.toLowerCase();
  const candidates = [...Object.keys(reg.models), ...Object.keys(reg.aliases ?? {})].sort(
    (a, b) => b.length - a.length,
  );
  for (const key of candidates) {
    if (lower.includes(key.toLowerCase())) {
      const target = reg.models[key] ? key : reg.aliases?.[key];
      if (target && reg.models[target]) return reg.models[target];
    }
  }
  return reg.default;
}

/**
 * Resolve per-TOKEN rates for a model id from the knowledge-tier cost registry.
 * Registry stores per-1k rates; returned rates are per-token (÷1000) for direct
 * multiplication by token counts in `record()`.
 */
export function resolveCostRates(model: string): CostRate {
  const perK = resolvePer1kRate(loadModelCostRegistry(), model);
  return { prompt: perK.prompt / 1000, completion: perK.completion / 1000 };
}

export interface MetricsOptions {
  metricsDir?: string;
  metricsFile?: string;
  persist?: boolean;
  memoryBudgetMB?: number;
}

export class MetricsCollector {
  private _metricsDir: string;
  private _metricsFile: string;
  private _persist: boolean;
  private _memoryBudgetMB: number;
  private _aggregates: Map<string, any>;

  constructor(options: MetricsOptions = {}) {
    this._metricsDir = options.metricsDir || DEFAULT_METRICS_DIR;
    this._metricsFile = options.metricsFile || DEFAULT_METRICS_FILE;
    this._persist = options.persist !== false;
    this._memoryBudgetMB = options.memoryBudgetMB || DEFAULT_MEMORY_BUDGET_MB;
    this._aggregates = new Map();
  }

  record(componentName: string, durationMs: number, status: 'success' | 'error', extra: any = {}) {
    const mem = process.memoryUsage();
    const memory = {
      heapUsedMB: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
      heapTotalMB: Math.round((mem.heapTotal / 1024 / 1024) * 100) / 100,
      rssMB: Math.round((mem.rss / 1024 / 1024) * 100) / 100,
    };

    if (memory.heapUsedMB > this._memoryBudgetMB) {
      console.warn(chalk.yellow(`[${componentName}] Memory budget exceeded: ${memory.heapUsedMB}MB (Budget: ${this._memoryBudgetMB}MB)`));
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
    agg.lastRun = new Date().toISOString();
    agg.peakHeapMB = Math.max(agg.peakHeapMB, memory.heapUsedMB);
    agg.peakRssMB = Math.max(agg.peakRssMB, memory.rssMB);

    if (extra.usage) {
      const pTokens = extra.usage.prompt_tokens || 0;
      const cTokens = extra.usage.completion_tokens || 0;
      agg.promptTokens += pTokens;
      agg.completionTokens += cTokens;
      agg.totalTokens += (pTokens + cTokens);

      const model = extra.model || 'default';
      const rates = resolveCostRates(model);
      const cost = (pTokens * rates.prompt) + (cTokens * rates.completion);
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

    if (this._persist) {
      this._appendToFile({
        component: componentName,
        duration_ms: durationMs,
        status,
        timestamp: agg.lastRun,
        memory,
        ...extra,
      });
    }
  }

  recordIntervention(context: string, decisionId: string) {
    this._appendToFile({
      type: 'intervention',
      context,
      decision: decisionId,
      timestamp: new Date().toISOString(),
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
    const filePath = path.join(this._metricsDir, this._metricsFile);
    if (!safeExistsSync(filePath)) return [];
    try {
      const content = safeReadFile(filePath, { encoding: 'utf8' }) as string;
      const lines = content.trim().split('\n').filter(Boolean);
      return lines.map((line) => JSON.parse(line));
    } catch (_) {
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
    const sloPath = sloPathCandidates.find(candidate => safeExistsSync(candidate));
    const sloTargets = sloPath
      ? JSON.parse(safeReadFile(sloPath, { encoding: 'utf8' }) as string)
      : { default: { latency_ms: 5000, success_rate: 99 } };

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

      const target = (sloTargets.critical_path && sloTargets.critical_path[componentName]) || sloTargets.default;
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
      if (name.includes('audit') || name.includes('scan') || name.includes('check')) manualMs = 900000;
      else if (name.includes('generate') || name.includes('create') || name.includes('artisan')) manualMs = 1800000;
      else if (name.includes('analyze') || name.includes('optimize')) manualMs = 3600000;

      const savedMs = Math.max(0, manualMs * s.count - s.totalMs);
      const savedCost = Math.round((savedMs / 3600000) * 100);

      const TIME_BASE = 5000;
      const timeImpact = Math.min(50, (avgMs / TIME_BASE) * 50);
      const cacheBonus = Math.round((cacheHitRatio / 100) * 20);
      const efficiencyScore = Math.max(0, Math.min(100, Math.round(100 - timeImpact + cacheBonus)));

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
      dateRange: entries.length > 0 ? { from: entries[0].timestamp, to: entries[entries.length - 1].timestamp } : null,
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
      if (!safeExistsSync(this._metricsDir)) {
        safeMkdir(this._metricsDir, { recursive: true });
      }
      const filePath = path.join(this._metricsDir, this._metricsFile);
      safeAppendFileSync(filePath, JSON.stringify(entry) + '\n');
    } catch (_) {}
  }
}

export const metrics = new MetricsCollector();
