import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MetricsCollector } from './metrics.js';

describe('metrics core', () => {
  it('should record and summarize aggregates correctly', () => {
    const mc = new MetricsCollector({ persist: false });
    mc.record('test-capability-a', 100, 'success');
    mc.record('test-capability-a', 200, 'success');
    mc.record('test-capability-a', 50, 'error');
    mc.record('test-capability-b', 300, 'success');

    const summaries = mc.summarize();
    expect(Array.isArray(summaries)).toBe(true);
    expect(summaries).toHaveLength(2);

    const capabilityA = summaries.find((s) => s.component === 'test-capability-a');
    expect(capabilityA).toBeDefined();
    expect(capabilityA!.executions).toBe(3);
    expect(capabilityA!.errors).toBe(1);
    expect(capabilityA!.errorRate).toBe(33.3);
    expect(capabilityA!.avgMs).toBe(117);
    expect(capabilityA!.minMs).toBe(50);
    expect(capabilityA!.maxMs).toBe(200);

    const capabilityB = summaries.find((s) => s.component === 'test-capability-b');
    expect(capabilityB).toBeDefined();
    expect(capabilityB!.executions).toBe(1);
    expect(capabilityB!.errors).toBe(0);
  });

  it('should return detailed metrics for a recorded capability', () => {
    const mc = new MetricsCollector({ persist: false });
    mc.record('my-capability', 150, 'success');
    mc.record('my-capability', 250, 'error');

    const result = mc.getCapabilityMetrics('my-capability');
    expect(result).not.toBeNull();
    expect(result.count).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.minMs).toBe(150);
    expect(result.maxMs).toBe(250);
    expect(result.totalMs / result.count).toBe(200);
    expect(typeof result.lastRun).toBe('string');
  });

  it('should capture peak memory values', () => {
    const mc = new MetricsCollector({ persist: false });
    mc.record('mem-test', 100, 'success');
    mc.record('mem-test', 200, 'success');

    const result = mc.getCapabilityMetrics('mem-test');
    expect(result.peakHeapMB).toBeGreaterThan(0);
    expect(result.peakRssMB).toBeGreaterThan(0);
    expect(result.peakRssMB).toBeGreaterThanOrEqual(result.peakHeapMB);
  });

  it('should return null for an unknown capability', () => {
    const mc = new MetricsCollector({ persist: false });
    const result = mc.getCapabilityMetrics('nonexistent-capability');
    expect(result).toBeNull();
  });

  it('should clear aggregates on reset', () => {
    const mc = new MetricsCollector({ persist: false });
    mc.record('reset-test', 100, 'success');
    expect(mc.summarize()).toHaveLength(1);
    mc.reset();
    expect(mc.summarize()).toHaveLength(0);
    expect(mc.getCapabilityMetrics('reset-test')).toBeNull();
  });

  it('should persist metrics history and load it back', () => {
    const metricsDir = path.join(process.cwd(), 'active/shared/tmp/metrics-test-persist');
    fs.rmSync(metricsDir, { recursive: true, force: true });

    const mc = new MetricsCollector({
      metricsDir,
      metricsFile: 'history.jsonl',
      persist: true,
    });

    mc.record('persist-capability', 120, 'success', {
      usage: { prompt_tokens: 100, completion_tokens: 50 },
      model: 'gpt-4o-mini',
      cacheStats: { hits: 1, misses: 2 },
      outputSize: 2048,
      recovered: true,
      intervention: true,
    });
    mc.recordIntervention('approval', 'decision-1');

    const history = mc.loadHistory();
    expect(history).toHaveLength(2);
    expect(history[0].component).toBe('persist-capability');
    expect(history[0].cost_usd).toBeGreaterThan(0);
    expect(history[1].type).toBe('intervention');
  });

  it('should build reports and regressions from persisted history', () => {
    const metricsDir = path.join(process.cwd(), 'active/shared/tmp/metrics-test-report');
    fs.rmSync(metricsDir, { recursive: true, force: true });
    fs.mkdirSync(metricsDir, { recursive: true });

    const historyPath = path.join(metricsDir, 'history.jsonl');
    const entries = [
      { skill: 'audit-capability', duration_ms: 100, status: 'success', timestamp: '2026-03-15T00:00:00.000Z', cacheStats: { hits: 1, misses: 0 } },
      { skill: 'audit-capability', duration_ms: 110, status: 'success', timestamp: '2026-03-15T00:01:00.000Z', cacheStats: { hits: 1, misses: 0 } },
      { skill: 'audit-capability', duration_ms: 105, status: 'success', timestamp: '2026-03-15T00:02:00.000Z', cacheStats: { hits: 1, misses: 0 } },
      { skill: 'audit-capability', duration_ms: 115, status: 'success', timestamp: '2026-03-15T00:03:00.000Z', cacheStats: { hits: 1, misses: 0 } },
      { skill: 'audit-capability', duration_ms: 500, status: 'success', timestamp: '2026-03-15T00:04:00.000Z', cacheStats: { hits: 0, misses: 1 } },
    ];
    fs.writeFileSync(historyPath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);

    const mc = new MetricsCollector({
      metricsDir,
      metricsFile: 'history.jsonl',
      persist: false,
    });

    const report = mc.reportFromHistory();
    expect(report.totalEntries).toBe(5);
    expect(report.uniqueSkills).toBe(1);
    expect(report.skills[0].skill).toBe('audit-capability');
    expect(report.skills[0].cacheHitRatio).toBeGreaterThan(0);

    const regressions = mc.detectRegressions(1.5);
    expect(regressions).toHaveLength(1);
    expect(regressions[0].skill).toBe('audit-capability');
    expect(regressions[0].lastDuration).toBe(500);
  });

  it('should honor component-based history entries and public slo targets', () => {
    const metricsDir = path.join(process.cwd(), 'active/shared/tmp/metrics-test-component-history');
    fs.rmSync(metricsDir, { recursive: true, force: true });
    fs.mkdirSync(metricsDir, { recursive: true });

    const historyPath = path.join(metricsDir, 'history.jsonl');
    const entries = [
      { component: 'code-actuator', duration_ms: 1000, status: 'success', timestamp: '2026-03-15T00:00:00.000Z' },
      { component: 'code-actuator', duration_ms: 17000, status: 'success', timestamp: '2026-03-15T00:01:00.000Z' },
    ];
    fs.writeFileSync(historyPath, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);

    const mc = new MetricsCollector({
      metricsDir,
      metricsFile: 'history.jsonl',
      persist: false,
    });

    const report = mc.reportFromHistory();
    expect(report.totalEntries).toBe(2);
    expect(report.uniqueSkills).toBe(1);
    expect(report.skills[0].component).toBe('code-actuator');
    expect(report.skills[0].skill).toBe('code-actuator');
    expect(report.skills[0].sloCompliance).toBe(50);
  });
});
