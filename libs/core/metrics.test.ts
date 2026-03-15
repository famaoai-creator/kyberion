import { describe, it, expect } from 'vitest';
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
});
