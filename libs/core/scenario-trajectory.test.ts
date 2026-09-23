import { describe, expect, it } from 'vitest';
import { compileSchema } from './foundation/ajv.js';
import { pathResolver } from './path-resolver.js';
import {
  appendScenarioApproval,
  appendScenarioOp,
  appendScenarioReasoning,
  createScenarioSideEffectLog,
} from './scenario-side-effect-log.js';
import { exportTrajectory } from './scenario-trajectory.js';
import { TraceContext } from './src/trace.js';

const validate = compileSchema(
  pathResolver.knowledge('product/schemas/scenario-trajectory.schema.json')
);

const SECRET = 'sk-live-TRAJECTORYSECRET0123456789';
const meta = { scenarioId: 'traj', runId: 'run-1', evidenceClass: 'simulated' as const };

function populatedLog() {
  const log = createScenarioSideEffectLog();
  appendScenarioReasoning(log, {
    method: 'prompt',
    backend: 'scenario-fixtures',
    prompt_hash: 'a'.repeat(64),
    prompt_length: 10,
    outcome: 'fixture',
    response_hash: 'b'.repeat(64),
    response_length: 4,
  });
  appendScenarioOp(log, { op: 'demo:apply', stage: 'preflight', source: 'actuator' });
  appendScenarioOp(log, {
    op: 'demo:apply',
    stage: 'preflight',
    source: 'pipeline',
    params: { api_key: SECRET, note: `token ${SECRET}` },
  });
  appendScenarioApproval(log, {
    op: 'demo:apply',
    kind: 'requested',
    channel: 'pipeline',
    decision: 'approved',
  });
  appendScenarioOp(log, {
    op: 'demo:apply',
    stage: 'apply',
    params: { api_key: SECRET, note: `token ${SECRET}` },
    outcome: 'ok',
  });
  appendScenarioReasoning(log, {
    method: 'prompt',
    backend: 'scenario-fixtures',
    prompt_hash: 'c'.repeat(64),
    prompt_length: 3,
    outcome: 'miss',
  });
  appendScenarioOp(log, { op: 'system:log', stage: 'preflight', source: 'pipeline' });
  appendScenarioOp(log, { op: 'system:exec', stage: 'preflight', source: 'pipeline' });
  appendScenarioOp(log, { op: 'system:exec', stage: 'unstubbed' });
  appendScenarioOp(log, {
    op: 'demo:gated',
    stage: 'preflight',
    source: 'pipeline',
    requiresApproval: true,
    approvalGranted: false,
  });
  return log;
}

describe('scenario trajectory export (ES-07)', () => {
  it('orders op invocations with their reasoning calls, outcome and approval', () => {
    const trace = new TraceContext('scenario:traj');
    trace.startSpan('demo:apply', { secret_attr: SECRET });
    trace.addEvent('actuator.resolved', { detail: SECRET });
    trace.endSpan();
    const record = exportTrajectory(trace.finalize(), populatedLog(), meta);

    expect(validate(record)).toBe(true);
    expect(record.steps.map((step) => [step.op, step.outcome])).toEqual([
      [null, null],
      ['demo:apply', 'ok'],
      ['system:log', 'passthrough'],
      ['system:exec', 'unstubbed'],
      ['demo:gated', 'held'],
    ]);
    expect(record.steps[0]?.reasoning_calls).toEqual([
      {
        backend: 'scenario-fixtures',
        prompt_hash: 'a'.repeat(64),
        prompt_len: 10,
        output_hash: 'b'.repeat(64),
        output_len: 4,
        outcome: 'fixture',
      },
    ]);
    expect(record.steps[1]?.reasoning_calls.map((call) => call.outcome)).toEqual(['miss']);
    expect(record.steps[1]?.approval).toEqual({ channel: 'pipeline', decision: 'approved' });
    expect(record.steps[1]?.observation_digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('never writes a secret-looking param or trace attribute into the record', () => {
    const trace = new TraceContext('scenario:traj');
    trace.startSpan('demo:apply', { secret_attr: SECRET });
    trace.addEvent('actuator.resolved', { detail: SECRET });
    trace.endSpan();
    const serialized = JSON.stringify(exportTrajectory(trace.finalize(), populatedLog(), meta));
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain('TRAJECTORYSECRET');
  });

  it('keeps an op held at admission as its own step, and a granted retry as a new one', () => {
    const log = createScenarioSideEffectLog();
    const held = {
      op: 'demo:gated',
      stage: 'preflight' as const,
      requiresApproval: true,
      approvalGranted: false,
    };
    appendScenarioOp(log, { ...held, source: 'actuator' });
    appendScenarioApproval(log, {
      op: 'demo:gated',
      kind: 'requested',
      channel: 'pipeline',
      decision: 'rejected',
    });
    appendScenarioOp(log, { ...held, approvalGranted: true, source: 'actuator' });
    appendScenarioOp(log, { ...held, approvalGranted: true, source: 'pipeline' });
    appendScenarioOp(log, { op: 'demo:gated', stage: 'apply', outcome: 'ok' });
    const record = exportTrajectory(undefined, log, meta);
    expect(
      record.steps.map((step) => [step.op, step.outcome, step.approval?.decision ?? null])
    ).toEqual([
      ['demo:gated', 'held', 'rejected'],
      ['demo:gated', 'ok', null],
    ]);
  });

  it('is deterministic for the same evidence and exports an empty run', () => {
    const log = populatedLog();
    expect(exportTrajectory(undefined, log, meta)).toEqual(exportTrajectory(undefined, log, meta));
    const empty = exportTrajectory(undefined, createScenarioSideEffectLog(), meta);
    expect(empty.steps).toEqual([]);
    expect(validate(empty)).toBe(true);
  });
});
