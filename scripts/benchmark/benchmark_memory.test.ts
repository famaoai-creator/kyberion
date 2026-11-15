import { describe, expect, it } from 'vitest';
import { runMemoryBenchmark } from './benchmark_memory.js';

describe('memory benchmark', () => {
  it('returns a deterministic passing report without running on import', () => {
    const report = runMemoryBenchmark();

    expect(report.benchmark).toBe('qm-03-memory-v-layer');
    expect(report.deterministic_at).toBe('2026-08-08T00:00:00.000Z');
    expect(report.passed).toBe(true);
    expect(report.checks).toHaveLength(5);
  });
});
