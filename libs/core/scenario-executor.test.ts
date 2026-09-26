import { afterEach, describe, expect, it, vi } from 'vitest';
import { getScenarioOpOverride, resolveActuatorOperation } from './actuator-op-registry.js';
import { getClock, systemClock } from './foundation/clock.js';
import { runOpPreflight } from './op-preflight.js';
import { pathResolver } from './path-resolver.js';
import { parseScenarioDefinition, type ScenarioDefinition } from './scenario-definition.js';
import {
  runScenario,
  type ScenarioPipelineRunner,
  type ScenarioPipelineRunRequest,
} from './scenario-executor.js';
import type { JudgeBackend } from './scenario-judge.js';
import type { TrajectoryRecord } from './scenario-trajectory.js';
import { safeExistsSync, safeReadFile, safeRmSync } from './secure-io.js';

function scenario(overrides: Record<string, unknown> = {}): ScenarioDefinition {
  return parseScenarioDefinition({
    schema_version: 'kyberion-scenario.v1',
    id: 'executor-fixture',
    title: 'Executor fixture',
    tier: 1,
    lane: 'pr-deterministic',
    executionProfile: 'simulated',
    modelFixtures: 'model-free',
    requires: {},
    seed: {
      files: [{ path: 'input/brief.txt', content: 'hello' }],
      clock: { start_iso: '2024-05-01T00:00:00.000Z' },
    },
    fixtures: { ops: { 'demo:apply': { result: { id: 'thing-1' } } } },
    turns: [{ kind: 'pipeline', steps: [{ op: 'demo:apply', params: { target: 'x' } }] }],
    finalChecks: [{ type: 'opCalled', op: 'demo:apply', times: 1 }],
    ...overrides,
  });
}

/** Minimal in-process engine: preflight, then dispatch through the interceptor seam. */
function fakeRunner(
  observe?: (request: ScenarioPipelineRunRequest) => void
): ScenarioPipelineRunner {
  return async (request) => {
    observe?.(request);
    let context: Record<string, unknown> = { ...request.context };
    for (const step of request.steps ?? []) {
      const op = String(step.op);
      const params = (step.params ?? {}) as Record<string, unknown>;
      request.trace.startSpan(op);
      await runOpPreflight({ op, params, source: 'pipeline' });
      const [domain, action] = op.split(':');
      try {
        const resolved = resolveActuatorOperation(domain!, action!);
        const out = await resolved!.handler!(
          action!,
          { ...params, export_as: 'out' },
          context,
          'apply'
        );
        context = out.ctx as Record<string, unknown>;
        request.trace.endSpan('ok');
      } catch (error) {
        request.trace.endSpan('error');
        return {
          status: 'failed',
          results: [{ op, status: 'failed', error: (error as Error).message }],
          context,
        };
      }
    }
    return { status: 'succeeded', results: [], context };
  };
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) safeRmSync(root, { recursive: true, force: true });
});

describe('runScenario (ES-05)', () => {
  it('runs a pipeline turn against fixtures with the virtual clock and seed in place', async () => {
    let seenNow = 0;
    let seedPresent = false;
    let trajectory: TrajectoryRecord | undefined;
    let runRoot = '';
    const report = await runScenario(scenario(), {
      seedNonce: `exec-${process.pid}-1`,
      onRunRoot: (value) => {
        runRoot = value;
      },
      exportTrajectory: true,
      onTrajectory: (value) => {
        trajectory = value;
      },
      runPipeline: fakeRunner((request) => {
        seenNow = getClock().now();
        const root = pathResolver.rootResolve(String(request.context.scenario_run_root));
        seedPresent = safeExistsSync(`${root}/input/brief.txt`);
      }),
    });

    expect(report.status).toBe('pass');
    expect(report.evidence_class).toBe('simulated');
    expect(report.started_at).toBe('2024-05-01T00:00:00.000Z');
    expect(seenNow).toBe(Date.parse('2024-05-01T00:00:00.000Z'));
    expect(seedPresent).toBe(true);
    expect(report.final_checks).toEqual([
      { type: 'opCalled', pass: true, detail: 'demo:apply called 1 time(s), expected 1 time(s)' },
    ]);
    expect(report.side_effects.ops_applied).toBe(1);
    expect(trajectory?.steps.map((step) => [step.op, step.outcome])).toEqual([
      ['demo:apply', 'ok'],
    ]);
    // Everything is torn down: clock, interceptor, run root.
    expect(getClock()).toBe(systemClock);
    expect(getScenarioOpOverride()).toBeUndefined();
    expect(runRoot.replaceAll('\\', '/')).toContain(`scenarios/${report.run_id}-`);
    expect(safeExistsSync(runRoot)).toBe(false);
  });

  it('keeps the run root with keep and records the turn artifact and approval transition', async () => {
    const def = scenario({
      seed: { approvals: [{ op: 'demo:apply', decision: 'rejected' }] },
      turns: [
        { kind: 'advance_clock', ms: 1500 },
        { kind: 'approval_decision', op: 'demo:apply', decision: 'approved' },
        {
          kind: 'pipeline',
          steps: [{ op: 'demo:apply', params: {} }],
          checks: {
            expectedOps: ['demo:apply'],
            forbiddenOps: ['system:exec'],
            responseMatchers: [{ path: 'out.id', equals: 'thing-1' }],
          },
        },
      ],
      finalChecks: [
        { type: 'approvalTransition', op: 'demo:apply', from: 'rejected', to: 'approved' },
        { type: 'artifactExists', path: 'turns/2.context.json' },
        { type: 'traceSpanExists', name: 'demo:apply' },
        { type: 'traceSpanExists', name: 'scenario.turn' },
      ],
    });
    let root = '';
    const report = await runScenario(def, {
      seedNonce: `exec-${process.pid}-2`,
      keep: true,
      onRunRoot: (value) => {
        root = value;
        roots.push(value);
      },
      runPipeline: fakeRunner(),
    });

    expect(report.status).toBe('pass');
    expect(report.duration_ms).toBe(1500);
    expect(report.turns.map((turn) => [turn.kind, turn.status, turn.duration_ms])).toEqual([
      ['advance_clock', 'pass', 1500],
      ['approval_decision', 'pass', 0],
      ['pipeline', 'pass', 0],
    ]);
    expect(report.turns[2]?.checks.every((check) => check.pass)).toBe(true);
    expect(safeExistsSync(root)).toBe(true);
    const artifact = JSON.parse(
      String(safeReadFile(`${root}/turns/2.context.json`, { encoding: 'utf8' }))
    );
    expect(artifact.out).toEqual({ id: 'thing-1' });
  });

  it('fails when a pipeline turn fails, and passes an expected failure', async () => {
    const unstubbed = [{ op: 'system:exec', params: { command: 'touch' } }];
    const failing = await runScenario(
      scenario({ turns: [{ kind: 'pipeline', steps: unstubbed }], finalChecks: [] }),
      { seedNonce: `exec-${process.pid}-3`, runPipeline: fakeRunner() }
    );
    expect(failing.status).toBe('fail');
    expect(failing.turns[0]?.error).toContain('[SCENARIO_UNSTUBBED_OP] system:exec');

    const expected = await runScenario(
      scenario({
        turns: [{ kind: 'pipeline', steps: unstubbed, expectError: '[SCENARIO_UNSTUBBED_OP]' }],
        finalChecks: [{ type: 'opNotCalled', op: 'system:exec' }],
      }),
      { seedNonce: `exec-${process.pid}-4`, runPipeline: fakeRunner() }
    );
    expect(expected.status).toBe('pass');
    expect(expected.turns[0]?.checks[0]).toMatchObject({ type: 'expectError', pass: true });

    const wrongly = await runScenario(
      scenario({
        turns: [{ kind: 'pipeline', steps: [{ op: 'demo:apply' }], expectError: 'never happens' }],
        finalChecks: [],
      }),
      { seedNonce: `exec-${process.pid}-5`, runPipeline: fakeRunner() }
    );
    expect(wrongly.status).toBe('fail');
    expect(wrongly.turns[0]?.checks[0]?.detail).toContain('succeeded but was expected to fail');
  });

  it('gates lanes, deferral, requirements and missing runners without running anything', async () => {
    const runner = vi.fn(fakeRunner());
    const liveOnly = scenario({ lane: 'live-only' });
    expect(
      await runScenario(liveOnly, { lane: 'pr-deterministic', runPipeline: runner })
    ).toMatchObject({ status: 'lane_skipped' });
    expect(
      await runScenario(
        scenario({ lane: 'live-only', deferred: { reason: 'waiting on provider' } }),
        { runPipeline: runner }
      )
    ).toMatchObject({ status: 'skipped', reason: 'deferred: waiting on provider' });
    const unmet = await runScenario(
      scenario({ requires: { env: ['KYBERION_SCENARIO_TEST_UNSET'], actuators: ['nope'] } }),
      { runPipeline: runner, env: {} }
    );
    expect(unmet.status).toBe('skipped');
    expect(unmet.reason).toBe(
      'unmet requirements: env KYBERION_SCENARIO_TEST_UNSET, actuator nope'
    );
    expect(await runScenario(scenario())).toMatchObject({ status: 'error' });
    expect(runner).not.toHaveBeenCalled();
  });

  it('skips intent/judge scenarios without live backends and judges independently when given', async () => {
    const live = scenario({
      lane: 'live-only',
      modelFixtures: 'fixtures',
      turns: [
        {
          kind: 'intent',
          text: 'summarize the brief',
          checks: {
            responseMatchers: [{ path: 'response', includes: 'summary' }],
            judge: { rubric: 'mentions the summary', minScore: 0.5 },
          },
        },
      ],
      finalChecks: [],
    });
    expect(await runScenario(live)).toMatchObject({
      status: 'skipped',
      reason: 'intent turns need a live reasoning backend (none available)',
    });

    const liveBackend: JudgeBackend = { name: 'actor-cli', prompt: async () => 'a summary' };
    const judgeBackend: JudgeBackend = {
      name: 'judge-cli',
      prompt: async () => '{"score": 0.9, "reason": "ok"}',
    };
    const report = await runScenario(live, {
      seedNonce: `exec-${process.pid}-6`,
      liveBackend,
      judgeBackend,
    });
    // No actor backend was observed (no reasoning log, no served mode): the judge is unavailable.
    expect(report.status).toBe('fail');
    expect(report.turns[0]?.checks.map((check) => [check.type, check.pass])).toEqual([
      ['responseMatcher', true],
      ['judge', false],
    ]);
    expect(report.turns[0]?.checks[1]?.detail).toContain('unavailable');
  });

  it('scopes the run: work outside it sees normal op resolution while turns see fixtures (FU-01)', async () => {
    const resolve = () => {
      try {
        return resolveActuatorOperation('demo', 'apply')?.source ?? 'none';
      } catch (error) {
        return (error as Error).message.slice(0, 12);
      }
    };
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    let entered!: () => void;
    const turnEntered = new Promise<void>((done) => {
      entered = done;
    });
    const outside = (async () => {
      await turnEntered;
      const seen = resolve();
      release();
      return seen;
    })();
    const base = fakeRunner();
    let insideSeen = '';
    const report = await runScenario(scenario(), {
      seedNonce: `scope-${process.pid}`,
      runPipeline: async (request) => {
        entered();
        await gate;
        insideSeen = resolve();
        return base(request);
      },
    });
    expect(report.status).toBe('pass');
    expect(insideSeen).toBe('scenario-fixture');
    await expect(outside).resolves.toBe('[UNKNOWN_OP]');
  });
});
