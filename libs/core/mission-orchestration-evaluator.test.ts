import { describe, expect, it } from 'vitest';
import { buildMissionOrchestrationEvaluationReport } from './mission-orchestration-evaluator.js';

describe('mission-orchestration-evaluator', () => {
  it('computes baseline vs orchestrated deltas', () => {
    const report = buildMissionOrchestrationEvaluationReport([
      {
        scenario_id: 'golden-code-change-reviewed',
        mode: 'baseline',
        completion_status: 'completed',
        clarification_count: 3,
        policy_violations: 1,
        contract_valid: true,
        operator_corrections: 2,
      },
      {
        scenario_id: 'golden-code-change-reviewed',
        mode: 'orchestrated',
        completion_status: 'completed',
        clarification_count: 1,
        policy_violations: 0,
        contract_valid: true,
        operator_corrections: 1,
      },
      {
        scenario_id: 'failure-delegation-path-violation',
        mode: 'baseline',
        completion_status: 'failed',
        clarification_count: 1,
        policy_violations: 2,
        contract_valid: false,
        operator_corrections: 1,
      },
      {
        scenario_id: 'failure-delegation-path-violation',
        mode: 'orchestrated',
        completion_status: 'blocked',
        clarification_count: 0,
        policy_violations: 0,
        contract_valid: true,
        operator_corrections: 0,
      },
    ], '2026-04-19T12:00:00.000Z');

    expect(report.kind).toBe('mission-orchestration-evaluation-report');
    expect(report.mode_metrics.baseline.run_count).toBe(2);
    expect(report.mode_metrics.orchestrated.run_count).toBe(2);
    expect(report.summary.orchestrated_policy_violations_delta).toBeLessThan(0);
    expect(report.summary.orchestrated_clarification_count_delta).toBeLessThan(0);
    expect(report.summary.orchestrated_contract_validity_delta).toBeGreaterThan(0);
    expect(report.scenario_deltas).toHaveLength(2);
  });
});
