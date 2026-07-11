import { describe, expect, it, vi } from 'vitest';
import {
  evaluateDegradation,
  loadHealthThresholds,
  runDegradationWatch,
  type LatencyRegression,
} from './health-degradation.js';

const REGRESSION: LatencyRegression = {
  skill: 'pdf-render',
  lastDuration: 9000,
  historicalAvg: 3000,
  increaseRate: 3,
};

describe('loadHealthThresholds', () => {
  it('loads the governed thresholds file', () => {
    const thresholds = loadHealthThresholds();
    expect(thresholds.regression_multiplier).toBeGreaterThan(1);
    expect(thresholds.red_regressions).toBeGreaterThan(0);
    expect(thresholds.red_demoted_providers).toBeGreaterThan(0);
  });
});

describe('evaluateDegradation', () => {
  it('green when there are no findings', () => {
    const report = evaluateDegradation({ regressions: [], demotedProviders: [] });
    expect(report.verdict).toBe('green');
    expect(report.findings).toHaveLength(0);
  });

  it('yellow for isolated regressions or demotions', () => {
    expect(evaluateDegradation({ regressions: [REGRESSION], demotedProviders: [] }).verdict).toBe(
      'yellow'
    );
    expect(evaluateDegradation({ regressions: [], demotedProviders: ['codex'] }).verdict).toBe(
      'yellow'
    );
  });

  it('red when regressions or demotions cross the red thresholds', () => {
    const manyRegressions = evaluateDegradation({
      regressions: [REGRESSION, REGRESSION, REGRESSION],
      demotedProviders: [],
    });
    expect(manyRegressions.verdict).toBe('red');
    expect(manyRegressions.findings.every((f) => f.severity === 'critical')).toBe(true);

    const manyDemotions = evaluateDegradation({
      regressions: [],
      demotedProviders: ['codex', 'gemini'],
    });
    expect(manyDemotions.verdict).toBe('red');
  });
});

describe('runDegradationWatch', () => {
  it('stays silent on green', () => {
    const alert = vi.fn();
    const { report, alert: receipt } = runDegradationWatch({
      regressions: [],
      demotedProviders: [],
      alert: alert as never,
    });
    expect(report.verdict).toBe('green');
    expect(receipt).toBeNull();
    expect(alert).not.toHaveBeenCalled();
  });

  it('escalates yellow as a warning ops-alert with a dedupe key', () => {
    const alert = vi.fn().mockReturnValue({ id: 'A-1' });
    const { report } = runDegradationWatch({
      regressions: [REGRESSION],
      demotedProviders: [],
      alert: alert as never,
    });
    expect(report.verdict).toBe('yellow');
    expect(alert).toHaveBeenCalledOnce();
    const input = alert.mock.calls[0][0];
    expect(input.severity).toBe('warning');
    expect(input.dedupe_key).toBe('health-degradation:yellow');
  });

  it('escalates red as a critical ops-alert', () => {
    const alert = vi.fn().mockReturnValue({ id: 'A-2' });
    runDegradationWatch({
      regressions: [],
      demotedProviders: ['codex', 'gemini'],
      alert: alert as never,
    });
    expect(alert.mock.calls[0][0].severity).toBe('critical');
  });
});
