import { describe, expect, it } from 'vitest';
import { resolveFinanceControllerDecision } from './finance-controller.js';
import type { FinancialModel } from './financial-model.js';
import type { OkrTracker } from './okr-tracker.js';

describe('finance-controller', () => {
  const baseFinancial: FinancialModel = {
    company_id: 'tenant-a',
    tenant_slug: 'tenant-a',
    source_kind: 'derived',
    source_path: '/tmp/financial-model.json',
    periods: [
      {
        period_id: 'current',
        label: 'Current',
        revenue_jpy: 1000000,
        operating_cost_jpy: 920000,
        gross_profit_jpy: 80000,
        budget_jpy: 1000000,
      },
    ],
  };

  const baseOkr: OkrTracker = {
    company_id: 'tenant-a',
    tenant_slug: 'tenant-a',
    source_kind: 'derived',
    source_path: '/tmp/okr.json',
    period: {
      period_id: 'current',
      label: 'Current',
    },
    objectives: [
      {
        objective: 'Improve operating efficiency',
        key_results: [
          {
            metric: 'cost control',
            target: 100,
            current: 42,
          },
        ],
      },
    ],
  };

  it('switches to cost cutting when budget, OKR, or token usage cross critical thresholds', () => {
    const decision = resolveFinanceControllerDecision({
      financial: {
        ...baseFinancial,
        periods: [
          {
            ...baseFinancial.periods[0],
            operating_cost_jpy: 980000,
            gross_profit_jpy: -25000,
            budget_jpy: 1000000,
          },
        ],
      },
      okr: {
        ...baseOkr,
        objectives: [
          {
            objective: 'Improve operating efficiency',
            key_results: [
              {
                metric: 'cost control',
                target: 100,
                current: 35,
              },
            ],
          },
        ],
      },
      costReport: {
        totalCostUsd: 420,
        totalTokens: 25000,
        promptTokens: 10000,
        completionTokens: 15000,
        sourcePath: '/tmp/cost-report.json',
      },
    });

    expect(decision.mode).toBe('cost_cutting');
    expect(decision.shouldCutCosts).toBe(true);
    expect(decision.reasons.some((reason) => reason.includes('Gross profit is negative'))).toBe(
      true
    );
    expect(decision.signals.budgetUtilization).toBe(0.98);
    expect(decision.signals.costReportTotalTokens).toBe(25000);
  });

  it('falls back to monitor and growth when only warning thresholds are crossed', () => {
    const monitorDecision = resolveFinanceControllerDecision({
      financial: {
        ...baseFinancial,
        periods: [
          {
            ...baseFinancial.periods[0],
            operating_cost_jpy: 780000,
            gross_profit_jpy: 220000,
            budget_jpy: 1000000,
          },
        ],
      },
      okr: {
        ...baseOkr,
        objectives: [
          {
            objective: 'Improve operating efficiency',
            key_results: [
              {
                metric: 'cost control',
                target: 100,
                current: 100,
              },
            ],
          },
        ],
      },
    });

    const growthDecision = resolveFinanceControllerDecision({
      financial: {
        ...baseFinancial,
        periods: [
          {
            ...baseFinancial.periods[0],
            operating_cost_jpy: 620000,
            gross_profit_jpy: 380000,
            budget_jpy: 1000000,
          },
        ],
      },
      okr: {
        ...baseOkr,
        objectives: [
          {
            objective: 'Improve operating efficiency',
            key_results: [
              {
                metric: 'cost control',
                target: 100,
                current: 100,
              },
            ],
          },
        ],
      },
    });

    expect(monitorDecision.mode).toBe('monitor');
    expect(monitorDecision.shouldCutCosts).toBe(false);
    expect(growthDecision.mode).toBe('growth');
    expect(growthDecision.reasons).toHaveLength(0);
  });
});
