import { describe, expect, it } from 'vitest';
import { evaluateDegradation } from './health-degradation.js';
import { evaluateRuntimeHealthTrends, type RuntimeHealthSample } from './runtime-health-history.js';

const THRESHOLDS = {
  rss_growth_warning_ratio: 1.5,
  rss_growth_red_ratio: 2.5,
  restart_warning_count: 3,
  restart_red_count: 10,
};

function sample(overrides: Partial<RuntimeHealthSample>): RuntimeHealthSample {
  return {
    timestamp: '2026-07-12T00:00:00.000Z',
    process_name: 'supervisor',
    rss_mb: 100,
    heap_used_mb: 50,
    ...overrides,
  };
}

describe('runtime health trends (OP-04)', () => {
  it('flags RSS growth beyond the warning and red ratios', () => {
    const warning = evaluateRuntimeHealthTrends(
      [sample({ rss_mb: 100 }), sample({ rss_mb: 160 })],
      THRESHOLDS
    );
    expect(warning).toEqual([expect.objectContaining({ kind: 'rss_growth', severity: 'warning' })]);

    const critical = evaluateRuntimeHealthTrends(
      [sample({ rss_mb: 100 }), sample({ rss_mb: 300 })],
      THRESHOLDS
    );
    expect(critical[0].severity).toBe('critical');
  });

  it('stays quiet for stable memory and single samples', () => {
    expect(
      evaluateRuntimeHealthTrends([sample({ rss_mb: 100 }), sample({ rss_mb: 120 })], THRESHOLDS)
    ).toEqual([]);
    expect(evaluateRuntimeHealthTrends([sample({ rss_mb: 100 })], THRESHOLDS)).toEqual([]);
  });

  it('flags restart storms from cumulative per-agent counts', () => {
    const findings = evaluateRuntimeHealthTrends(
      [
        sample({ restarts: { 'agent-a': 1, 'agent-b': 0 } }),
        sample({ restarts: { 'agent-a': 3, 'agent-b': 2 } }),
      ],
      THRESHOLDS
    );
    expect(findings).toEqual([
      expect.objectContaining({ kind: 'restart_frequency', severity: 'warning' }),
    ]);
    expect(findings[0].detail).toContain('4 agent restart(s)');
  });

  it('feeds the degradation verdict (yellow on trend warnings)', () => {
    const report = evaluateDegradation({
      regressions: [],
      demotedProviders: [],
      runtimeSamples: [sample({ rss_mb: 100 }), sample({ rss_mb: 180 })],
    });
    expect(report.verdict).toBe('yellow');
    expect(report.findings[0].kind).toBe('rss_growth');
  });
});
