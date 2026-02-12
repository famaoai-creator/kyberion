const fs = require('fs');
const path = require('path');

/**
 * Lightweight metrics collection for Gemini Skills.
 * Tracks execution timing, error rates, and usage patterns.
 * Stores data in append-only JSONL format for analysis.
 *
 * Usage:
 *   const { metrics } = require('../../scripts/lib/metrics.cjs');
 *   metrics.record('my-skill', 150, 'success');
 *   const report = metrics.summarize();
 *
 * @module metrics
 */

const DEFAULT_METRICS_DIR = path.join(process.cwd(), 'work', 'metrics');
const DEFAULT_METRICS_FILE = 'skill-metrics.jsonl';

// Default budget per skill execution (can be overridden)
const DEFAULT_MEMORY_BUDGET_MB = 200;

/**
 * In-memory aggregator for skill execution metrics.
 * Also supports persistent JSONL logging.
 */
class MetricsCollector {
  constructor(options = {}) {
    this._metricsDir = options.metricsDir || DEFAULT_METRICS_DIR;
    this._metricsFile = options.metricsFile || DEFAULT_METRICS_FILE;
    this._persist = options.persist !== false;
    this._memoryBudgetMB = options.memoryBudgetMB || DEFAULT_MEMORY_BUDGET_MB;
    /** @type {Map<string, {count: number, errors: number, totalMs: number, minMs: number, maxMs: number, lastRun: string, peakHeapMB: number, peakRssMB: number}>} */
    this._aggregates = new Map();
  }

  /**
   * Record a skill execution metric.
   * @param {string} skillName - Name of the skill
   * @param {number} durationMs - Execution time in milliseconds
   * @param {'success'|'error'} status - Execution result
   * @param {Object} [extra] - Additional metadata
   */
  record(skillName, durationMs, status, extra = {}) {
    // Capture memory snapshot
    const mem = process.memoryUsage();
    const memory = {
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024 * 100) / 100,
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024 * 100) / 100,
      rssMB: Math.round(mem.rss / 1024 / 1024 * 100) / 100,
    };

    // Check budget
    if (memory.heapUsedMB > this._memoryBudgetMB) {
      const { logger } = require('./core.cjs');
      logger.warn(`[${skillName}] Memory budget exceeded: ${memory.heapUsedMB}MB (Budget: ${this._memoryBudgetMB}MB)`);
    }

    // Update in-memory aggregates
    let agg = this._aggregates.get(skillName);
    if (!agg) {
      agg = { count: 0, errors: 0, totalMs: 0, minMs: Infinity, maxMs: 0, lastRun: '', peakHeapMB: 0, peakRssMB: 0 };
      this._aggregates.set(skillName, agg);
    }
    agg.count++;
    if (status === 'error') agg.errors++;
    agg.totalMs += durationMs;
    agg.minMs = Math.min(agg.minMs, durationMs);
    agg.maxMs = Math.max(agg.maxMs, durationMs);
    agg.lastRun = new Date().toISOString();
    agg.peakHeapMB = Math.max(agg.peakHeapMB, memory.heapUsedMB);
    agg.peakRssMB = Math.max(agg.peakRssMB, memory.rssMB);

    // Persist to JSONL
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

  /**
   * Get aggregated metrics for all recorded skills.
   * @returns {Object[]} Array of skill metric summaries
   */
  summarize() {
    const summaries = [];
    const TIME_BASE = 5000; // 5s baseline
    const MEM_BASE = 200;   // 200MB baseline

    for (const [name, agg] of this._aggregates) {
      const avgMs = agg.count > 0 ? Math.round(agg.totalMs / agg.count) : 0;
      
      // Efficiency Score: Higher is better (0-100)
      // Penalizes both high latency and high memory usage
      const timeImpact = Math.min(50, (avgMs / TIME_BASE) * 50);
      const memImpact = Math.min(50, (agg.peakHeapMB / MEM_BASE) * 50);
      const efficiencyScore = Math.max(0, Math.round(100 - (timeImpact + memImpact)));

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
      });
    }
    return summaries.sort((a, b) => b.executions - a.executions);
  }

  /**
   * Get metrics for a single skill.
   * @param {string} skillName
   * @returns {Object|null} Metric summary or null
   */
  getSkillMetrics(skillName) {
    const agg = this._aggregates.get(skillName);
    if (!agg) return null;
    return {
      skill: skillName,
      executions: agg.count,
      errors: agg.errors,
      errorRate: agg.count > 0 ? Math.round((agg.errors / agg.count) * 1000) / 10 : 0,
      avgMs: agg.count > 0 ? Math.round(agg.totalMs / agg.count) : 0,
      minMs: agg.minMs === Infinity ? 0 : agg.minMs,
      maxMs: agg.maxMs,
      lastRun: agg.lastRun,
      peakHeapMB: agg.peakHeapMB,
      peakRssMB: agg.peakRssMB,
    };
  }

  /**
   * Load historical metrics from the JSONL file.
   * @returns {Object[]} Array of raw metric entries
   */
  loadHistory() {
    const filePath = path.join(this._metricsDir, this._metricsFile);
    if (!fs.existsSync(filePath)) return [];
    try {
      const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
      return lines.map(line => JSON.parse(line));
    } catch (_) {
      return [];
    }
  }

  /**
   * Generate a report from historical data.
   * @returns {Object} Report with per-skill aggregates from history
   */
  reportFromHistory() {
    const entries = this.loadHistory();
    const bySkill = {};
    for (const entry of entries) {
      if (!bySkill[entry.skill]) {
        bySkill[entry.skill] = { count: 0, errors: 0, totalMs: 0, minMs: Infinity, maxMs: 0 };
      }
      const s = bySkill[entry.skill];
      s.count++;
      if (entry.status === 'error') s.errors++;
      s.totalMs += entry.duration_ms || 0;
      s.minMs = Math.min(s.minMs, entry.duration_ms || 0);
      s.maxMs = Math.max(s.maxMs, entry.duration_ms || 0);
    }

    const skills = Object.entries(bySkill).map(([name, s]) => ({
      skill: name,
      executions: s.count,
      errors: s.errors,
      errorRate: s.count > 0 ? Math.round((s.errors / s.count) * 1000) / 10 : 0,
      avgMs: s.count > 0 ? Math.round(s.totalMs / s.count) : 0,
      minMs: s.minMs === Infinity ? 0 : s.minMs,
      maxMs: s.maxMs,
    }));

    return {
      totalEntries: entries.length,
      uniqueSkills: skills.length,
      dateRange: entries.length > 0
        ? { from: entries[0].timestamp, to: entries[entries.length - 1].timestamp }
        : null,
      skills: skills.sort((a, b) => b.executions - a.executions),
    };
  }

  /**
   * Detect performance regressions by comparing recent runs to historical averages.
   * @param {number} [thresholdMultiplier=1.5] - Multiplier for avg duration to flag regression
   * @returns {Object[]} Array of flagged skills with details
   */
  detectRegressions(thresholdMultiplier = 1.5) {
    const entries = this.loadHistory();
    const bySkill = {};
    for (const entry of entries) {
      if (!bySkill[entry.skill]) bySkill[entry.skill] = [];
      bySkill[entry.skill].push(entry);
    }

    const regressions = [];
    for (const [name, runs] of Object.entries(bySkill)) {
      if (runs.length < 5) continue; // Need enough history
      
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

  /** Reset in-memory aggregates. */
  reset() {
    this._aggregates.clear();
  }

  /** @private */
  _appendToFile(entry) {
    try {
      if (!fs.existsSync(this._metricsDir)) {
        fs.mkdirSync(this._metricsDir, { recursive: true });
      }
      const filePath = path.join(this._metricsDir, this._metricsFile);
      fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
    } catch (_) {
      // Silently ignore write errors to avoid disrupting skill execution
    }
  }
}

// Singleton instance for convenience
const metrics = new MetricsCollector();

module.exports = { MetricsCollector, metrics };
