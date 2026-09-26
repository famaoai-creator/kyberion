import { describe, expect, it } from 'vitest';
import { compileSchema } from './foundation/ajv.js';
import { pathResolver } from './path-resolver.js';
import { parseScenarioDefinition, type ScenarioDefinition } from './scenario-definition.js';
import { assertNotSimulatedEvidence } from './scenario-evidence-class.js';
import {
  buildScenarioReport,
  isFailingScenarioStatus,
  renderScenarioReportMarkdown,
  summarizeSideEffects,
} from './scenario-report.js';
import {
  appendScenarioApproval,
  appendScenarioOp,
  appendScenarioWarning,
  createScenarioSideEffectLog,
  MAX_SCENARIO_WARNINGS,
} from './scenario-side-effect-log.js';

const validate = compileSchema(
  pathResolver.knowledge('product/schemas/kyberion-scenario-report.schema.json')
);

function scenario(overrides: Partial<ScenarioDefinition> = {}): ScenarioDefinition {
  return parseScenarioDefinition({
    schema_version: 'kyberion-scenario.v1',
    id: 'report-fixture',
    title: 'Report fixture',
    tier: 1,
    lane: 'pr-deterministic',
    executionProfile: 'simulated',
    modelFixtures: 'model-free',
    requires: {},
    seed: {},
    fixtures: { ops: {} },
    turns: [],
    finalChecks: [],
    ...overrides,
  });
}

describe('scenario report (ES-05)', () => {
  it('builds a schema-valid report whose evidence class follows the execution profile', () => {
    const log = createScenarioSideEffectLog();
    appendScenarioOp(log, { op: 'demo:apply', stage: 'apply', outcome: 'ok' });
    appendScenarioOp(log, { op: 'system:exec', stage: 'unstubbed' });
    appendScenarioApproval(log, {
      op: 'demo:apply',
      kind: 'requested',
      channel: 'pipeline',
      decision: 'pending',
    });
    const report = buildScenarioReport({
      def: scenario(),
      runId: 'run-1',
      status: 'fail',
      turns: [
        {
          index: 0,
          kind: 'pipeline',
          status: 'fail',
          checks: [{ type: 'expectedOp', pass: false, detail: 'demo | x\\ called 0 time(s)' }],
          duration_ms: 0,
        },
      ],
      finalChecks: [{ type: 'opCalled', pass: true, detail: 'ok' }],
      log,
      startedAtMs: Date.UTC(2020, 0, 1),
      finishedAtMs: Date.UTC(2020, 0, 1) + 1500,
      wallMs: 12,
    });

    expect(validate(report)).toBe(true);
    expect(report).toMatchObject({
      schema_version: 'kyberion-scenario-report.v1',
      evidence_class: 'simulated',
      started_at: '2020-01-01T00:00:00.000Z',
      finished_at: '2020-01-01T00:00:01.500Z',
      duration_ms: 1500,
      side_effects: summarizeSideEffects(log),
    });
    expect(report.side_effects).toMatchObject({
      ops_applied: 1,
      ops_unstubbed: 1,
      approvals_requested: 1,
    });
    expect(() => assertNotSimulatedEvidence(report, 'release-evidence')).toThrow(
      '[SIMULATED_EVIDENCE_REJECTED]'
    );

    const markdown = renderScenarioReportMarkdown(report);
    expect(markdown).toContain('# Scenario report-fixture: FAIL');
    expect(markdown).toContain('| FAIL | expectedOp | demo \\| x\\\\ called 0 time(s) |');
    expect(markdown).toContain('## Final checks');
  });

  it('marks provider-qualified reports as such and records skip reasons', () => {
    const report = buildScenarioReport({
      def: scenario({ lane: 'live-only', executionProfile: 'provider-qualified' }),
      runId: 'run-2',
      status: 'lane_skipped',
      reason: 'live-only scenario outside the pr-deterministic lane',
      startedAtMs: 0,
      finishedAtMs: 0,
      wallMs: 0,
    });
    expect(validate(report)).toBe(true);
    expect(report.evidence_class).toBe('provider-qualified');
    expect(report.reason).toContain('live-only');
    expect(() => assertNotSimulatedEvidence(report, 'release-evidence')).not.toThrow();
  });

  it('only fail and error statuses fail a suite', () => {
    expect(
      ['pass', 'fail', 'skipped', 'lane_skipped', 'error'].map((s) =>
        isFailingScenarioStatus(s as never)
      )
    ).toEqual([false, true, false, false, true]);
  });

  it('surfaces scope_lost warnings grouped by op and source (FU-01)', () => {
    const log = createScenarioSideEffectLog();
    appendScenarioWarning(log, { kind: 'scope_lost', op: 'demo:apply', source: 'pipeline' });
    appendScenarioWarning(log, { kind: 'scope_lost', op: 'demo:apply', source: 'op-dispatch' });
    appendScenarioWarning(log, { kind: 'scope_lost', op: 'demo:apply', source: 'pipeline' });
    const report = buildScenarioReport({
      def: scenario(),
      runId: 'run-w',
      status: 'pass',
      log,
      startedAtMs: 0,
      finishedAtMs: 0,
      wallMs: 0,
    });
    expect(report.warnings).toEqual([
      { kind: 'scope_lost', op: 'demo:apply', source: 'pipeline', count: 2 },
      { kind: 'scope_lost', op: 'demo:apply', source: 'op-dispatch', count: 1 },
    ]);
    expect(validate(report)).toBe(true);
    expect(renderScenarioReportMarkdown(report)).toContain(
      '- warning scope_lost: demo:apply via pipeline (2x)'
    );
    const clean = buildScenarioReport({
      def: scenario(),
      runId: 'run-c',
      status: 'pass',
      log: createScenarioSideEffectLog(),
      startedAtMs: 0,
      finishedAtMs: 0,
      wallMs: 0,
    });
    expect(clean).not.toHaveProperty('warnings');
  });

  it('surfaces a warnings_dropped count once the warning cap is hit (N5)', () => {
    const log = createScenarioSideEffectLog();
    for (let i = 0; i < MAX_SCENARIO_WARNINGS + 3; i += 1) {
      appendScenarioWarning(log, { kind: 'scope_lost', op: 'demo:apply', source: 'pipeline' });
    }
    const report = buildScenarioReport({
      def: scenario(),
      runId: 'run-dropped',
      status: 'pass',
      log,
      startedAtMs: 0,
      finishedAtMs: 0,
      wallMs: 0,
    });
    expect(report.warnings_dropped).toBe(3);
    expect(validate(report)).toBe(true);
    expect(renderScenarioReportMarkdown(report)).toContain(
      '- warning cap reached: 3 warning(s) dropped'
    );

    const underCap = buildScenarioReport({
      def: scenario(),
      runId: 'run-under-cap',
      status: 'pass',
      log: createScenarioSideEffectLog(),
      startedAtMs: 0,
      finishedAtMs: 0,
      wallMs: 0,
    });
    expect(underCap).not.toHaveProperty('warnings_dropped');
  });
});
