import { describe, it, expect } from 'vitest';
import { projectScenario, compareScenarios, SCENARIO_TEMPLATES, BaseAssumptions } from './lib.js';

describe('scenario-multiverse-orchestrator lib', () => {
  const mockBase: BaseAssumptions = {
    name: 'MultiCorp',
    timeframe_months: 12,
    mrr: 50000,
    current_headcount: 10,
    monthlyBurn: 60000,
    cashOnHand: 200000,
  };

  it('should project a scenario correctly', () => {
    const template = SCENARIO_TEMPLATES.aggressive_growth;
    const result = projectScenario(mockBase, template, 12);

    expect(result.scenario).toBe(template.label);
    expect(result.timeline).toHaveLength(4); // 3, 6, 9, 12
    expect(result.endState.mrr).toBeGreaterThan(mockBase.mrr!);
    expect(result.projectedHeadcount).toBe(Math.round(10 * 1.5));
  });

  it('should handle infinite runway when profitable', () => {
    const profitableBase: BaseAssumptions = {
      ...mockBase,
      mrr: 100000,
      monthlyBurn: 50000,
    };
    const result = projectScenario(profitableBase, SCENARIO_TEMPLATES.stability, 12);
    expect(result.endState.profitable).toBe(true);
    expect(result.endState.runwayMonths).toBe('infinite');
  });

  it('should compare multiple scenarios correctly', () => {
    const scenarios = [
      projectScenario(mockBase, SCENARIO_TEMPLATES.aggressive_growth, 12),
      projectScenario(mockBase, SCENARIO_TEMPLATES.sustainable_growth, 12),
      projectScenario(mockBase, SCENARIO_TEMPLATES.stability, 12),
    ];

    const comparison = compareScenarios(scenarios);
    expect(comparison.highestRevenue).toBe(SCENARIO_TEMPLATES.aggressive_growth.label);
    expect(comparison.lowestRisk).toBe(SCENARIO_TEMPLATES.stability.label);
    expect(comparison.recommended).toBe(SCENARIO_TEMPLATES.sustainable_growth.label);
  });

  it('should recommend stability when runway is critically short', () => {
    const tightBase: BaseAssumptions = {
      ...mockBase,
      cashOnHand: 10000, // Very low cash
      monthlyBurn: 100000,
    };
    const scenarios = [
      projectScenario(tightBase, SCENARIO_TEMPLATES.sustainable_growth, 12),
      projectScenario(tightBase, SCENARIO_TEMPLATES.stability, 12),
    ];
    const comparison = compareScenarios(scenarios);
    expect(comparison.recommended).toBe(SCENARIO_TEMPLATES.stability.label);
  });
});
