import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';

/**
 * Lightweight metrics collection for Gemini Skills.
 */

const DEFAULT_METRICS_DIR = path.join(process.cwd(), 'work', 'metrics');
const DEFAULT_METRICS_FILE = 'skill-metrics.jsonl';
const DEFAULT_MEMORY_BUDGET_MB = 200;

const COST_TABLE: Record<string, { prompt: number; completion: number }> = {
  'gpt-4o': { prompt: 0.005 / 1000, completion: 0.015 / 1000 },
  'gpt-4o-mini': { prompt: 0.00015 / 1000, completion: 0.0006 / 1000 },
  'claude-3-5-sonnet': { prompt: 0.003 / 1000, completion: 0.015 / 1000 },
  'gemini-1.5-pro': { prompt: 0.00125 / 1000, completion: 0.00375 / 1000 },
  'gemini-1.5-flash': { prompt: 0.000075 / 1000, completion: 0.0003 / 1000 },
  'default': { prompt: 0.001 / 1000, completion: 0.003 / 1000 },
};

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

  record(skillName: string, durationMs: number, status: 'success' | 'error', extra: any = {}) {
    const mem = process.memoryUsage();
    const memory = {
      heapUsedMB: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
      heapTotalMB: Math.round((mem.heapTotal / 1024 / 1024) * 100) / 100,
      rssMB: Math.round((mem.rss / 1024 / 1024) * 100) / 100,
    };

    if (memory.heapUsedMB > this._memoryBudgetMB) {
      console.warn(chalk.yellow(`[${skillName}] Memory budget exceeded: ${memory.heapUsedMB}MB (Budget: ${this._memoryBudgetMB}MB)`));
    }

    let agg = this._aggregates.get(skillName);
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
      this._aggregates.set(skillName, agg);
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
      const rates = COST_TABLE[model] || COST_TABLE['default'];
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
        skill: skillName,
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
        skill: name,
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

  loadHistory() {
    const filePath = path.join(this._metricsDir, this._metricsFile);
    if (!fs.existsSync(filePath)) return [];
    try {
      const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
      return lines.map((line) => JSON.parse(line));
    } catch (_) {
      return [];
    }
  }

  reportFromHistory() {
    const entries = this.loadHistory();
    const bySkill: Record<string, any> = {};
    const sloPath = path.resolve(process.cwd(), 'knowledge/orchestration/slo-targets.json');
    const sloTargets = fs.existsSync(sloPath)
      ? JSON.parse(fs.readFileSync(sloPath, 'utf8'))
      : { default: { latency_ms: 5000, success_rate: 99 } };

    for (const entry of entries) {
      if (!bySkill[entry.skill]) {
        bySkill[entry.skill] = {
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
      const s = bySkill[entry.skill];
      s.count++;
      if (entry.status === 'error') s.errors++;
      s.totalMs += entry.duration_ms || 0;
      s.minMs = Math.min(s.minMs, entry.duration_ms || 0);
      s.maxMs = Math.max(s.maxMs, entry.duration_ms || 0);

      const target = (sloTargets.critical_path && sloTargets.critical_path[entry.skill]) || sloTargets.default;
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
      if (!fs.existsSync(this._metricsDir)) {
        fs.mkdirSync(this._metricsDir, { recursive: true });
      }
      const filePath = path.join(this._metricsDir, this._metricsFile);
      fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
    } catch (_) {}
  }
}

export const metrics = new MetricsCollector();
