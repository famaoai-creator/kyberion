/**
 * ES-05: scenario report (`kyberion-scenario-report.v1`).
 *
 * `evidence_class` always comes from the scenario's execution profile
 * (`evidenceClassForProfile`), so a simulated run can never be mistaken for
 * provider evidence (see `assertNotSimulatedEvidence`). Timestamps come from
 * the run's virtual clock; `wall_ms` is the only non-deterministic field.
 */

import type { ScenarioDefinition, ScenarioLane, ScenarioTurn } from './scenario-definition.js';
import {
  evidenceClassForProfile,
  SCENARIO_REPORT_SCHEMA_VERSION,
  type ScenarioEvidenceClass,
} from './scenario-evidence-class.js';
import type { ScenarioCheckResult } from './scenario-final-checks.js';
import type { ScenarioSideEffectLog } from './scenario-side-effect-log.js';

export type ScenarioRunStatus = 'pass' | 'fail' | 'skipped' | 'lane_skipped' | 'error';
export type ScenarioTurnStatus = 'pass' | 'fail' | 'error';

export interface ScenarioTurnReport {
  index: number;
  kind: ScenarioTurn['kind'];
  status: ScenarioTurnStatus;
  checks: ScenarioCheckResult[];
  /** Virtual-clock duration of the turn. */
  duration_ms: number;
  error?: string;
}

export interface ScenarioSideEffectSummary {
  ops_applied: number;
  ops_unstubbed: number;
  approvals_requested: number;
  approvals_decided: number;
  writes: number;
  reasoning_calls: number;
}

export interface ScenarioReport {
  schema_version: typeof SCENARIO_REPORT_SCHEMA_VERSION;
  scenario_id: string;
  title: string;
  run_id: string;
  lane: ScenarioLane;
  execution_profile: ScenarioDefinition['executionProfile'];
  evidence_class: ScenarioEvidenceClass;
  status: ScenarioRunStatus;
  /** Why the scenario was skipped / lane_skipped / errored. */
  reason?: string;
  turns: ScenarioTurnReport[];
  final_checks: ScenarioCheckResult[];
  side_effects: ScenarioSideEffectSummary;
  started_at: string;
  finished_at: string;
  /** Virtual-clock duration (deterministic). */
  duration_ms: number;
  /** Wall-clock duration (informational, non-deterministic). */
  wall_ms: number;
}

export function emptySideEffectSummary(): ScenarioSideEffectSummary {
  return {
    ops_applied: 0,
    ops_unstubbed: 0,
    approvals_requested: 0,
    approvals_decided: 0,
    writes: 0,
    reasoning_calls: 0,
  };
}

export function summarizeSideEffects(log: ScenarioSideEffectLog): ScenarioSideEffectSummary {
  return {
    ops_applied: log.ops.filter((record) => record.stage === 'apply').length,
    ops_unstubbed: log.ops.filter((record) => record.stage === 'unstubbed').length,
    approvals_requested: log.approvals.filter((record) => record.kind === 'requested').length,
    approvals_decided: log.approvals.filter((record) => record.kind === 'decided').length,
    writes: log.writes.length,
    reasoning_calls: log.reasoning.length,
  };
}

export interface BuildScenarioReportInput {
  def: ScenarioDefinition;
  runId: string;
  status: ScenarioRunStatus;
  reason?: string;
  turns?: ScenarioTurnReport[];
  finalChecks?: ScenarioCheckResult[];
  log?: ScenarioSideEffectLog;
  startedAtMs: number;
  finishedAtMs: number;
  wallMs: number;
}

export function buildScenarioReport(input: BuildScenarioReportInput): ScenarioReport {
  return {
    schema_version: SCENARIO_REPORT_SCHEMA_VERSION,
    scenario_id: input.def.id,
    title: input.def.title,
    run_id: input.runId,
    lane: input.def.lane,
    execution_profile: input.def.executionProfile,
    evidence_class: evidenceClassForProfile(input.def.executionProfile),
    status: input.status,
    ...(input.reason ? { reason: input.reason } : {}),
    turns: input.turns ?? [],
    final_checks: input.finalChecks ?? [],
    side_effects: input.log ? summarizeSideEffects(input.log) : emptySideEffectSummary(),
    started_at: new Date(input.startedAtMs).toISOString(),
    finished_at: new Date(input.finishedAtMs).toISOString(),
    duration_ms: input.finishedAtMs - input.startedAtMs,
    wall_ms: input.wallMs,
  };
}

/** A run fails the suite only on fail/error; skipped and lane_skipped never do. */
export function isFailingScenarioStatus(status: ScenarioRunStatus): boolean {
  return status === 'fail' || status === 'error';
}

function escapeCell(value: string): string {
  return value.replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ');
}

function checkRows(checks: readonly ScenarioCheckResult[]): string[] {
  return checks.map(
    (check) => `| ${check.pass ? 'PASS' : 'FAIL'} | ${check.type} | ${escapeCell(check.detail)} |`
  );
}

export function renderScenarioReportMarkdown(report: ScenarioReport): string {
  const lines = [
    `# Scenario ${report.scenario_id}: ${report.status.toUpperCase()}`,
    '',
    `- title: ${report.title}`,
    `- run_id: ${report.run_id}`,
    `- lane: ${report.lane}`,
    `- evidence_class: ${report.evidence_class}`,
    `- started_at: ${report.started_at} (virtual clock), duration ${report.duration_ms}ms, wall ${report.wall_ms}ms`,
  ];
  if (report.reason) lines.push(`- reason: ${escapeCell(report.reason)}`);
  const effects = report.side_effects;
  lines.push(
    `- side effects: ${effects.ops_applied} applied, ${effects.ops_unstubbed} unstubbed, ` +
      `${effects.approvals_requested} approval requests, ${effects.approvals_decided} decisions, ` +
      `${effects.writes} writes, ${effects.reasoning_calls} reasoning calls`
  );
  for (const turn of report.turns) {
    lines.push('', `## Turn ${turn.index} (${turn.kind}): ${turn.status}`);
    if (turn.error) lines.push('', `error: ${escapeCell(turn.error)}`);
    if (turn.checks.length > 0) {
      lines.push(
        '',
        '| result | check | detail |',
        '| --- | --- | --- |',
        ...checkRows(turn.checks)
      );
    }
  }
  if (report.final_checks.length > 0) {
    lines.push(
      '',
      '## Final checks',
      '',
      '| result | check | detail |',
      '| --- | --- | --- |',
      ...checkRows(report.final_checks)
    );
  }
  return `${lines.join('\n')}\n`;
}
