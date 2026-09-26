import { afterEach, describe, expect, it, vi } from 'vitest';
import { TraceContext } from '@agent/core';
import { registerPluginActuatorOperation } from '@agent/core/actuator-op-registry';
import { registerOpGuard } from '@agent/core/op-preflight';
import { evaluateFinalCheck } from '@agent/core/scenario-final-checks';
import { parseScenarioDefinition, type ScenarioDefinition } from '@agent/core/scenario-definition';
import { installScenarioInterceptor } from '@agent/core/scenario-interceptor';
import { createScenarioRunContext } from '@agent/core/scenario-run-context';
import { safeRmSync } from '@agent/core/secure-io';

// Load through the same specifier the pipeline entry uses so the test shares
// one instance of the engine module graph.
const { runValidatedSteps } = await import(new URL('./run_pipeline.js', import.meta.url).href);

function scenario(overrides: Partial<ScenarioDefinition> = {}): ScenarioDefinition {
  return parseScenarioDefinition({
    schema_version: 'kyberion-scenario.v1',
    id: 'pipeline-scenario-override',
    title: 'Pipeline scenario override',
    tier: 1,
    lane: 'pr-deterministic',
    executionProfile: 'simulated',
    modelFixtures: 'model-free',
    requires: {},
    seed: {},
    fixtures: {
      ops: {
        'scenariodemo:fetch': { result: { id: 'thing-1' } },
        'scenariodemo:apply': { ctx_patch: { applied: true } },
      },
    },
    turns: [],
    finalChecks: [],
    ...overrides,
  });
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function install(def: ScenarioDefinition) {
  const ctx = createScenarioRunContext(def, { seedNonce: `pipeline-${cleanups.length}` });
  const interceptor = installScenarioInterceptor(ctx, def);
  cleanups.push(() => {
    interceptor.dispose();
    safeRmSync(ctx.runRoot, { recursive: true, force: true });
  });
  return interceptor;
}

function registerSpyOp(action: string) {
  const handler = vi.fn(
    async (_op: string, _params: Record<string, unknown>, ctx: Record<string, unknown>) => ({
      handled: true,
      ctx: { ...ctx, real_handler_ran: true },
    })
  );
  cleanups.push(
    registerPluginActuatorOperation({
      domain: 'scenariodemo',
      action,
      stepType: 'apply',
      pluginId: 'scenario-test-plugin',
      modulePath: 'plugins/scenario-test-plugin/index.js',
      handler,
    })
  );
  return handler;
}

const twoSteps = [
  { id: 'fetch', op: 'scenariodemo:fetch', role: 'source' as const, produces: 'thing', params: {} },
  { id: 'apply', op: 'scenariodemo:apply', params: { target: '{{thing.id}}' } },
];

describe('pipeline dispatch with the scenario interceptor (ES-02)', () => {
  it('without an interceptor the real handler runs (previous behaviour)', async () => {
    const real = registerSpyOp('apply');
    const result = await runValidatedSteps([twoSteps[1]], {}, { quiet: true, hasHuman: false });
    expect(result.status).toBe('succeeded');
    expect(real).toHaveBeenCalledTimes(1);
  });

  it('serves a 2-step pipeline from fixtures and never calls the real handler', async () => {
    const real = registerSpyOp('apply');
    const interceptor = install(scenario());
    const trace = new TraceContext('scenario-test');
    const addEvent = vi.spyOn(trace, 'addEvent');

    const result = await interceptor.runInScope(() =>
      runValidatedSteps(twoSteps, {}, { quiet: true, hasHuman: false, trace })
    );

    expect(result.status).toBe('succeeded');
    expect(real).not.toHaveBeenCalled();
    expect(result.context).toMatchObject({ thing: { id: 'thing-1' }, applied: true });
    expect(interceptor.log.ops.map((r) => [r.op, r.stage, r.outcome ?? null])).toEqual([
      // adf-engine admission (source 'actuator'), then leaf dispatch (source 'pipeline').
      ['scenariodemo:fetch', 'preflight', null],
      ['scenariodemo:fetch', 'preflight', null],
      ['scenariodemo:fetch', 'apply', 'ok'],
      ['scenariodemo:apply', 'preflight', null],
      ['scenariodemo:apply', 'preflight', null],
      ['scenariodemo:apply', 'apply', 'ok'],
    ]);
    expect(interceptor.log.ops.map((r) => r.source ?? null)).toEqual([
      'actuator',
      'pipeline',
      null,
      'actuator',
      'pipeline',
      null,
    ]);
    expect(interceptor.log.ops[5]?.params).toEqual({ target: 'thing-1' });
    const resolved = addEvent.mock.calls.filter(([name]) => name === 'actuator.resolved');
    expect(resolved.map(([, attrs]) => attrs?.resolution_source)).toEqual([
      'scenario-fixture',
      'scenario-fixture',
    ]);
  });

  it('fails an unstubbed op closed before any inline or real dispatch', async () => {
    const interceptor = install(scenario());
    const result = await interceptor.runInScope(() =>
      runValidatedSteps(
        [
          {
            id: 'exec',
            op: 'system:exec',
            params: { command: 'touch', args: ['should-not-exist'] },
          },
        ],
        {},
        { quiet: true, hasHuman: false }
      )
    );
    expect(result.status).toBe('failed');
    expect(result.results[0].error).toContain('[SCENARIO_UNSTUBBED_OP] system:exec');
    expect(interceptor.log.ops.map((r) => r.stage)).toEqual([
      'preflight',
      'preflight',
      'unstubbed',
    ]);
  });

  it('a rejected approval leaves no apply record; an approved one applies', async () => {
    const gated = [{ ...twoSteps[1], params: {}, budget: { approval_required: true } }];

    const rejected = install(
      scenario({ seed: { approvals: [{ op: 'scenariodemo:apply', decision: 'rejected' }] } })
    );
    const denied = await rejected.runInScope(() =>
      runValidatedSteps(gated, {}, { quiet: true, hasHuman: false })
    );
    expect(denied.status).toBe('failed');
    expect(denied.results[0].error).toContain('[OP_PREFLIGHT_BLOCK]');
    expect(rejected.log.ops.filter((r) => r.stage === 'apply')).toEqual([]);
    expect(rejected.log.approvals).toMatchObject([
      { op: 'scenariodemo:apply', kind: 'requested', decision: 'rejected' },
    ]);
    rejected.setApprovalDecision('scenariodemo:apply', 'approved');
    const approved = await rejected.runInScope(() =>
      runValidatedSteps(gated, {}, { quiet: true, hasHuman: false })
    );
    expect(approved.status).toBe('succeeded');
    expect(rejected.log.ops.filter((r) => r.stage === 'apply')).toHaveLength(1);
    expect(rejected.log.ops.at(-2)).toMatchObject({ stage: 'preflight', approvalGranted: true });
  });

  it('serves an approved core:run_pipeline fixture without running the nested pipeline', async () => {
    const nestedRunner = vi.fn(async () => ({ status: 'succeeded', results: [], context: {} }));
    const interceptor = install(
      scenario({
        fixtures: { ops: { 'core:run_pipeline': { ctx_patch: { nested_from_fixture: true } } } },
        seed: { approvals: [{ op: 'core:run_pipeline', decision: 'approved' }] },
      })
    );
    const result = await interceptor.runInScope(() =>
      runValidatedSteps(
        [
          {
            id: 'nested',
            op: 'core:run_pipeline',
            params: { input: 'pipelines/vital-check.json' },
            budget: { approval_required: true },
          },
        ],
        {},
        { quiet: true, hasHuman: false, runPipelineFile: nestedRunner }
      )
    );
    expect(result.status).toBe('succeeded');
    expect(nestedRunner).not.toHaveBeenCalled();
    expect(result.context).toMatchObject({ nested_from_fixture: true });
    expect(interceptor.log.ops.filter((r) => r.stage === 'apply')).toMatchObject([
      { op: 'core:run_pipeline', outcome: 'ok' },
    ]);
  });

  it('leaves an unfixtured core:run_pipeline on its normal path in the simulated profile', async () => {
    const nestedRunner = vi.fn(async () => ({ status: 'succeeded', results: [], context: {} }));
    const interceptor = install(scenario());
    const result = await interceptor.runInScope(() =>
      runValidatedSteps(
        [
          {
            id: 'nested',
            op: 'core:run_pipeline',
            params: { input: 'pipelines/vital-check.json' },
          },
        ],
        {},
        { quiet: true, hasHuman: false, runPipelineFile: nestedRunner }
      )
    );
    expect(result.status).toBe('succeeded');
    expect(nestedRunner).toHaveBeenCalledTimes(1);
  });

  it('does not count a passthrough op another guard blocked as called', async () => {
    const interceptor = install(scenario());
    cleanups.push(
      registerOpGuard({
        id: 'test-block-system-log',
        // Block at leaf dispatch, after adf-engine admission let it through.
        check: (call) =>
          call.op === 'system:log' && call.source === 'pipeline'
            ? { decision: 'block', reason: 'blocked by test' }
            : undefined,
      })
    );
    const result = await interceptor.runInScope(() =>
      runValidatedSteps(
        [{ id: 'log', op: 'system:log', params: { message: 'hello' } }],
        {},
        { quiet: true, hasHuman: false }
      )
    );
    expect(result.status).toBe('failed');
    expect(
      interceptor.log.ops.some(
        (r) => r.op === 'system:log' && r.stage === 'preflight' && r.source === 'pipeline'
      )
    ).toBe(true);
    const runRoot = { runRoot: '' };
    expect(
      evaluateFinalCheck(
        { type: 'opNotCalled', op: 'system:log' },
        interceptor.log,
        undefined,
        runRoot
      ).pass
    ).toBe(true);
    expect(
      evaluateFinalCheck(
        { type: 'opCalled', op: 'system:log' },
        interceptor.log,
        undefined,
        runRoot
      ).pass
    ).toBe(false);
  });

  it('counts an admitted passthrough op as called', async () => {
    const interceptor = install(scenario());
    const result = await interceptor.runInScope(() =>
      runValidatedSteps(
        [{ id: 'log', op: 'system:log', params: { message: 'hello' } }],
        {},
        { quiet: true, hasHuman: false }
      )
    );
    expect(result.status).toBe('succeeded');
    expect(
      evaluateFinalCheck(
        { type: 'opCalled', op: 'system:log', times: 1 },
        interceptor.log,
        undefined,
        { runRoot: '' }
      ).pass
    ).toBe(true);
  });

  it('leaves pipelines run outside the scenario scope on their normal path (FU-01)', async () => {
    const real = registerSpyOp('apply');
    const interceptor = install(
      scenario({ seed: { approvals: [{ op: 'scenariodemo:apply', decision: 'approved' }] } })
    );
    const gated = [{ ...twoSteps[1], params: {}, budget: { approval_required: true } }];
    const outside = await runValidatedSteps([twoSteps[1]], {}, { quiet: true, hasHuman: false });
    expect(outside.status).toBe('succeeded');
    expect(real).toHaveBeenCalledTimes(1);
    // The scenario's approval decision is not visible to out-of-scope work either.
    const outsideGated = await runValidatedSteps(gated, {}, { quiet: true, hasHuman: false });
    expect(outsideGated.status).toBe('failed');
    expect(real).toHaveBeenCalledTimes(1);
    expect(interceptor.log.ops).toEqual([]);
    expect(interceptor.log.approvals).toEqual([]);
  });
});
