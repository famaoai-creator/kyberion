import { describe, expect, it, vi } from 'vitest';
import {
  evaluateDegradation,
  loadHealthThresholds,
  runDegradationWatch,
  type LatencyRegression,
} from './health-degradation.js';
import type { FinanceControllerDecision } from './finance-controller.js';

const REGRESSION: LatencyRegression = {
  skill: 'pdf-render',
  lastDuration: 9000,
  historicalAvg: 3000,
  increaseRate: 3,
};

function financeDecision(
  mode: FinanceControllerDecision['mode'],
  reasons: string[]
): FinanceControllerDecision {
  return {
    mode,
    shouldCutCosts: mode === 'cost_cutting',
    reasons,
    signals: {
      revenueJpy: null,
      operatingCostJpy: null,
      grossProfitJpy: null,
      budgetJpy: null,
      budgetUtilization: null,
      okrProgressPercent: null,
      costReportTotalUsd: null,
      costReportTotalTokens: null,
    },
    thresholds: {
      budgetUtilizationWarning: 0.75,
      budgetUtilizationCritical: 0.9,
      negativeGrossProfitBudgetMode: true,
      lowOkrProgressWarning: 75,
      lowOkrProgressCritical: 50,
      highTokenUsageWarning: 5000,
      highTokenUsageCritical: 20000,
    },
    sources: { financialPath: 'test', okrPath: 'test', costReportPath: null },
  };
}

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

  it('ignores a growth-mode finance decision', () => {
    const report = evaluateDegradation({
      regressions: [],
      demotedProviders: [],
      financeDecision: financeDecision('growth', []),
    });
    expect(report.verdict).toBe('green');
    expect(report.findings).toHaveLength(0);
  });

  it('warns on a budget/KPI signal in monitor mode', () => {
    const report = evaluateDegradation({
      regressions: [],
      demotedProviders: [],
      financeDecision: financeDecision('monitor', ['OKR progress is behind (60%)']),
    });
    expect(report.verdict).toBe('yellow');
    expect(report.findings).toEqual([
      {
        kind: 'budget_or_kpi_signal',
        severity: 'warning',
        detail: 'OKR progress is behind (60%)',
      },
    ]);
  });

  it('escalates a budget overrun in cost_cutting mode to critical', () => {
    const report = evaluateDegradation({
      regressions: [],
      demotedProviders: [],
      financeDecision: financeDecision('cost_cutting', ['Budget utilization is 95.0%']),
    });
    expect(report.verdict).toBe('red');
    expect(report.findings[0]).toMatchObject({
      kind: 'budget_or_kpi_signal',
      severity: 'critical',
    });
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

  it('escalates a cost_cutting finance decision to a critical ops-alert', () => {
    const alert = vi.fn().mockReturnValue({ id: 'A-3' });
    const { report } = runDegradationWatch({
      regressions: [],
      demotedProviders: [],
      financeDecision: financeDecision('cost_cutting', ['Gross profit is negative']),
      alert: alert as never,
    });
    expect(report.verdict).toBe('red');
    expect(alert).toHaveBeenCalledOnce();
    expect(alert.mock.calls[0][0].severity).toBe('critical');
  });
});
