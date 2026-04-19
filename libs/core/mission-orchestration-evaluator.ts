export type OrchestrationEvaluationMode = 'baseline' | 'orchestrated';
export type OrchestrationCompletionStatus = 'completed' | 'blocked' | 'failed';

export interface OrchestrationScenarioRunRecord {
  scenario_id: string;
  mode: OrchestrationEvaluationMode;
  completion_status: OrchestrationCompletionStatus;
  clarification_count: number;
  policy_violations: number;
  contract_valid: boolean;
  operator_corrections: number;
}

export interface OrchestrationModeMetrics {
  run_count: number;
  completion_rate: number;
  policy_violations_per_run: number;
  clarification_count_per_run: number;
  contract_validity_rate: number;
  operator_correction_rate: number;
}

export interface OrchestrationScenarioDelta {
  scenario_id: string;
  completion_improved: boolean;
  policy_violations_delta: number;
  clarification_count_delta: number;
  contract_validity_delta: number;
  operator_correction_rate_delta: number;
}

export interface MissionOrchestrationEvaluationReport {
  kind: 'mission-orchestration-evaluation-report';
  evaluated_at: string;
  summary: {
    orchestrated_completion_rate_delta: number;
    orchestrated_policy_violations_delta: number;
    orchestrated_clarification_count_delta: number;
    orchestrated_contract_validity_delta: number;
    orchestrated_operator_correction_rate_delta: number;
  };
  mode_metrics: {
    baseline: OrchestrationModeMetrics;
    orchestrated: OrchestrationModeMetrics;
  };
  scenario_deltas: OrchestrationScenarioDelta[];
}

function safeDivide(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

function round3(value: number): number {
  return Number(value.toFixed(3));
}

function modeMetrics(records: OrchestrationScenarioRunRecord[], mode: OrchestrationEvaluationMode): OrchestrationModeMetrics {
  const filtered = records.filter((record) => record.mode === mode);
  const runCount = filtered.length;
  const completed = filtered.filter((record) => record.completion_status === 'completed').length;
  const contractValid = filtered.filter((record) => record.contract_valid).length;
  const policyViolations = filtered.reduce((sum, record) => sum + Math.max(0, record.policy_violations || 0), 0);
  const clarificationCount = filtered.reduce((sum, record) => sum + Math.max(0, record.clarification_count || 0), 0);
  const correctionCount = filtered.reduce((sum, record) => sum + Math.max(0, record.operator_corrections || 0), 0);
  return {
    run_count: runCount,
    completion_rate: round3(safeDivide(completed, runCount)),
    policy_violations_per_run: round3(safeDivide(policyViolations, runCount)),
    clarification_count_per_run: round3(safeDivide(clarificationCount, runCount)),
    contract_validity_rate: round3(safeDivide(contractValid, runCount)),
    operator_correction_rate: round3(safeDivide(correctionCount, runCount)),
  };
}

function scenarioDelta(records: OrchestrationScenarioRunRecord[], scenarioId: string): OrchestrationScenarioDelta {
  const baselineRecords = records.filter((record) => record.scenario_id === scenarioId && record.mode === 'baseline');
  const orchestratedRecords = records.filter((record) => record.scenario_id === scenarioId && record.mode === 'orchestrated');
  const baseline = modeMetrics(baselineRecords, 'baseline');
  const orchestrated = modeMetrics(orchestratedRecords, 'orchestrated');
  return {
    scenario_id: scenarioId,
    completion_improved: orchestrated.completion_rate > baseline.completion_rate,
    policy_violations_delta: round3(orchestrated.policy_violations_per_run - baseline.policy_violations_per_run),
    clarification_count_delta: round3(orchestrated.clarification_count_per_run - baseline.clarification_count_per_run),
    contract_validity_delta: round3(orchestrated.contract_validity_rate - baseline.contract_validity_rate),
    operator_correction_rate_delta: round3(orchestrated.operator_correction_rate - baseline.operator_correction_rate),
  };
}

export function buildMissionOrchestrationEvaluationReport(
  records: OrchestrationScenarioRunRecord[],
  evaluatedAt = new Date().toISOString(),
): MissionOrchestrationEvaluationReport {
  const baseline = modeMetrics(records, 'baseline');
  const orchestrated = modeMetrics(records, 'orchestrated');
  const scenarioIds = Array.from(new Set(records.map((record) => record.scenario_id))).sort();
  const deltas = scenarioIds.map((scenarioId) => scenarioDelta(records, scenarioId));
  return {
    kind: 'mission-orchestration-evaluation-report',
    evaluated_at: evaluatedAt,
    summary: {
      orchestrated_completion_rate_delta: round3(orchestrated.completion_rate - baseline.completion_rate),
      orchestrated_policy_violations_delta: round3(orchestrated.policy_violations_per_run - baseline.policy_violations_per_run),
      orchestrated_clarification_count_delta: round3(orchestrated.clarification_count_per_run - baseline.clarification_count_per_run),
      orchestrated_contract_validity_delta: round3(orchestrated.contract_validity_rate - baseline.contract_validity_rate),
      orchestrated_operator_correction_rate_delta: round3(orchestrated.operator_correction_rate - baseline.operator_correction_rate),
    },
    mode_metrics: {
      baseline,
      orchestrated,
    },
    scenario_deltas: deltas,
  };
}
