import { describe, it, expect } from 'vitest';
import { MetricsCollector } from './metrics.js';

describe('metrics core', () => {
  it('should record and summarize aggregates correctly', () => {
    const mc = new MetricsCollector({ persist: false });
    mc.record('test-skill-a', 100, 'success');
    mc.record('test-skill-a', 200, 'success');
    mc.record('test-skill-a', 50, 'error');
    mc.record('test-skill-b', 300, 'success');

    const summaries = mc.summarize();
    expect(Array.isArray(summaries)).toBe(true);
    expect(summaries).toHaveLength(2);

    const skillA = summaries.find((s) => s.skill === 'test-skill-a');
    expect(skillA).toBeDefined();
    expect(skillA!.executions).toBe(3);
    expect(skillA!.errors).toBe(1);
    expect(skillA!.errorRate).toBe(33.3);
    expect(skillA!.avgMs).toBe(117);
    expect(skillA!.minMs).toBe(50);
    expect(skillA!.maxMs).toBe(200);

    const skillB = summaries.find((s) => s.skill === 'test-skill-b');
    expect(skillB).toBeDefined();
    expect(skillB!.executions).toBe(1);
    expect(skillB!.errors).toBe(0);
  });

  it('should return detailed metrics for a recorded skill', () => {
    const mc = new MetricsCollector({ persist: false });
    mc.record('my-skill', 150, 'success');
    mc.record('my-skill', 250, 'error');

    const result = mc.getSkillMetrics('my-skill');
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

    const result = mc.getSkillMetrics('mem-test');
    expect(result.peakHeapMB).toBeGreaterThan(0);
    expect(result.peakRssMB).toBeGreaterThan(0);
    expect(result.peakRssMB).toBeGreaterThanOrEqual(result.peakHeapMB);
  });

  it('should return null for an unknown skill', () => {
    const mc = new MetricsCollector({ persist: false });
    const result = mc.getSkillMetrics('nonexistent-skill');
    expect(result).toBeNull();
  });

  it('should clear aggregates on reset', () => {
    const mc = new MetricsCollector({ persist: false });
    mc.record('reset-test', 100, 'success');
    expect(mc.summarize()).toHaveLength(1);
    mc.reset();
    expect(mc.summarize()).toHaveLength(0);
    expect(mc.getSkillMetrics('reset-test')).toBeNull();
  });
});
