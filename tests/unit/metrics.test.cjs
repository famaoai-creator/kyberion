/**
 * Standalone tests for @agent/core/metrics module.
 *
 * Extracted from the monolithic unit.test.cjs for independent execution.
 * Run: node tests/unit/metrics.test.cjs
 */

const { test, assert, harness } = require('../harness.cjs');

// ========================================
// MetricsCollector record and summarize
// ========================================
console.log('\n--- MetricsCollector ---');

test('record and summarize aggregates correctly', () => {
  const { MetricsCollector } = require('@agent/core/metrics');
  const mc = new MetricsCollector({ persist: false });
  mc.record('test-skill-a', 100, 'success');
  mc.record('test-skill-a', 200, 'success');
  mc.record('test-skill-a', 50, 'error');
  mc.record('test-skill-b', 300, 'success');

  const summaries = mc.summarize();
  assert(Array.isArray(summaries), 'summarize should return array');
  assert(summaries.length === 2, 'Should have 2 skills');

  const skillA = summaries.find((s) => s.skill === 'test-skill-a');
  assert(skillA !== undefined, 'Should find test-skill-a');
  assert(skillA.executions === 3, 'test-skill-a should have 3 executions');
  assert(skillA.errors === 1, 'test-skill-a should have 1 error');
  assert(skillA.errorRate === 33.3, `Error rate should be 33.3, got ${skillA.errorRate}`);
  assert(skillA.avgMs === 117, `Avg should be 117ms, got ${skillA.avgMs}`);
  assert(skillA.minMs === 50, `Min should be 50ms, got ${skillA.minMs}`);
  assert(skillA.maxMs === 200, `Max should be 200ms, got ${skillA.maxMs}`);

  const skillB = summaries.find((s) => s.skill === 'test-skill-b');
  assert(skillB !== undefined, 'Should find test-skill-b');
  assert(skillB.executions === 1, 'test-skill-b should have 1 execution');
  assert(skillB.errors === 0, 'test-skill-b should have 0 errors');
});

test('getSkillMetrics returns details for recorded skill', () => {
  const { MetricsCollector } = require('@agent/core/metrics');
  const mc = new MetricsCollector({ persist: false });
  mc.record('my-skill', 150, 'success');
  mc.record('my-skill', 250, 'error');

  const result = mc.getSkillMetrics('my-skill');
  assert(result !== null, 'Should return metrics for recorded skill');
  assert(result.skill === 'my-skill', 'Should have correct skill name');
  assert(result.executions === 2, 'Should have 2 executions');
  assert(result.errors === 1, 'Should have 1 error');
  assert(result.minMs === 150, 'Min should be 150');
  assert(result.maxMs === 250, 'Max should be 250');
  assert(result.avgMs === 200, 'Avg should be 200');
  assert(typeof result.lastRun === 'string', 'Should have lastRun timestamp');
});

test('memory tracking captures peak values', () => {
  const { MetricsCollector } = require('@agent/core/metrics');
  const mc = new MetricsCollector({ persist: false });
  mc.record('mem-test', 100, 'success');
  mc.record('mem-test', 200, 'success');

  const result = mc.getSkillMetrics('mem-test');
  assert(result.peakHeapMB > 0, 'peakHeapMB should be positive after recording');
  assert(result.peakRssMB > 0, 'peakRssMB should be positive after recording');
  assert(result.peakRssMB >= result.peakHeapMB, 'RSS should be >= heap');
});

test('getSkillMetrics returns null for unknown skill', () => {
  const { MetricsCollector } = require('@agent/core/metrics');
  const mc = new MetricsCollector({ persist: false });
  const result = mc.getSkillMetrics('nonexistent-skill');
  assert(result === null, 'Should return null for unknown skill');
});

test('reset clears aggregates', () => {
  const { MetricsCollector } = require('@agent/core/metrics');
  const mc = new MetricsCollector({ persist: false });
  mc.record('reset-test', 100, 'success');
  assert(mc.summarize().length === 1, 'Should have 1 skill before reset');
  mc.reset();
  assert(mc.summarize().length === 0, 'Should have 0 skills after reset');
  assert(mc.getSkillMetrics('reset-test') === null, 'Should return null after reset');
});

harness.report();
