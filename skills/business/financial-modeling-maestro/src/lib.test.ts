import { describe, it, expect } from 'vitest';
import { generatePnL, analyzeRunway, generateScenarios, FinancialAssumptions } from './lib.js';

describe('financial-modeling-maestro lib', () => {
  const mockAssumptions: FinancialAssumptions = {
    mrr: 10000,
    growthRate: 0.1,
    churnRate: 0.02,
    cashOnHand: 50000,
    costs: { initial_monthly_cost: 5000, headcount: 2, avg_salary: 60000 },
  };

  it('should generate PnL projections correctly', () => {
    const result = generatePnL(mockAssumptions, 1);
    expect(result.monthly).toHaveLength(12);
    expect(result.yearly).toHaveLength(1);
    expect(result.monthly[0].mrr).toBeGreaterThan(10000);
    expect(result.yearly[0].annualRevenue).toBeGreaterThan(120000);
  });

  it('should analyze runway and breakeven correctly', () => {
    const projections = generatePnL(mockAssumptions, 3);
    const runway = analyzeRunway(projections.monthly);
    expect(runway.sustainable).toBe(true);
    expect(runway.breakevenMonth).toBeDefined();
  });

  it('should identify cash out scenario', () => {
    const poorAssumptions: FinancialAssumptions = {
      ...mockAssumptions,
      growthRate: 0,
      costs: { ...mockAssumptions.costs!, initial_monthly_cost: 20000 },
      cashOnHand: 10000,
    };
    const projections = generatePnL(poorAssumptions, 1);
    const runway = analyzeRunway(projections.monthly);
    expect(runway.sustainable).toBe(false);
    expect(runway.runwayMonths).toBeLessThan(12);
  });

  it('should generate base, optimistic and pessimistic scenarios', () => {
    const scenarios = generateScenarios(mockAssumptions, 1);
    expect(scenarios.base).toBeDefined();
    expect(scenarios.optimistic).toBeDefined();
    expect(scenarios.pessimistic).toBeDefined();
    expect(scenarios.optimistic.yearly[0].annualRevenue).toBeGreaterThan(
      scenarios.base.yearly[0].annualRevenue
    );
    expect(scenarios.pessimistic.yearly[0].annualRevenue).toBeLessThan(
      scenarios.base.yearly[0].annualRevenue
    );
  });

  it('should clamp invalid inputs to sensible ranges', () => {
    const invalidInput: FinancialAssumptions = {
      mrr: -1000,
      growthRate: 10,
      churnRate: 2,
      costs: { headcount: -5 },
    };
    const result = generatePnL(invalidInput, 1);
    expect(result.monthly[0].mrr).toBeGreaterThanOrEqual(0);
    expect(result.monthly[0].expenses).toBeGreaterThanOrEqual(0);
  });
});
