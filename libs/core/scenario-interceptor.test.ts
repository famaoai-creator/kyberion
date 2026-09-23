import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getScenarioOpOverride, resolveActuatorOperation } from './actuator-op-registry.js';
import { listOpPreflightListeners, runOpPreflight } from './op-preflight.js';
import { getReasoningBackend, stubReasoningBackend } from './reasoning-backend.js';
import { requireRiskyApproval } from './risky-op-approval-port.js';
import { parseScenarioDefinition, type ScenarioDefinition } from './scenario-definition.js';
import {
  installScenarioInterceptor,
  SCENARIO_CAPTURE_LISTENER_ID,
  type ScenarioInterceptor,
} from './scenario-interceptor.js';
import { createScenarioRunContext, type ScenarioRunContext } from './scenario-run-context.js';
import { safeMkdir, safeRmSync, safeUnlinkSync, safeWriteFile } from './secure-io.js';

function scenario(overrides: Partial<ScenarioDefinition> = {}): ScenarioDefinition {
  return parseScenarioDefinition({
    schema_version: 'kyberion-scenario.v1',
    id: 'interceptor-fixture',
    title: 'Interceptor fixture',
    tier: 1,
    lane: 'pr-deterministic',
    executionProfile: 'simulated',
    modelFixtures: 'model-free',
    requires: {},
    seed: {},
    fixtures: {
      ops: {
        'demo:apply_thing': { ctx_patch: { applied: true }, result: { id: 'thing-1' } },
        'demo:broken': { error: 'fixture failure' },
      },
    },
    turns: [],
    finalChecks: [],
    ...overrides,
  });
}

const cleanups: Array<() => void> = [];

function setup(def: ScenarioDefinition = scenario()): {
  interceptor: ScenarioInterceptor;
  ctx: ScenarioRunContext;
} {
  const ctx = createScenarioRunContext(def, { seedNonce: `${process.pid}-${cleanups.length}` });
  ctx.materializeSeedFiles();
  const interceptor = installScenarioInterceptor(ctx, def);
  cleanups.push(() => {
    interceptor.dispose();
    safeRmSync(ctx.runRoot, { recursive: true, force: true });
  });
  return { interceptor, ctx };
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('installScenarioInterceptor (ES-02)', () => {
  it('records admitted ops observe-only, with redacted params, and never decides', async () => {
    const { interceptor } = setup();
    const result = await runOpPreflight({
      op: 'demo:apply_thing',
      params: { target: 'x', api_key: 'sk-abcdefghijklmnopqrstuvwx' },
      source: 'pipeline',
    });
    expect(result.decision).toBe('allow');
    expect(result.listener_ids).toContain(SCENARIO_CAPTURE_LISTENER_ID);
    expect(interceptor.log.ops).toEqual([
      {
        seq: 1,
        op: 'demo:apply_thing',
        stage: 'preflight',
        params: { target: 'x', api_key: '[REDACTED_SECRET]' },
        source: 'pipeline',
        requiresApproval: false,
        approvalGranted: false,
      },
    ]);

    // Approval-required and not granted: the built-in guard still asks.
    const gated = await runOpPreflight({
      op: 'demo:apply_thing',
      params: {},
      source: 'pipeline',
      requiresApproval: true,
      approvalGranted: false,
    });
    expect(gated.decision).toBe('ask');
    expect(interceptor.log.approvals).toEqual([
      {
        seq: 3,
        op: 'demo:apply_thing',
        kind: 'requested',
        channel: 'pipeline',
        decision: 'pending',
      },
    ]);
  });

  it('serves fixtures without touching real handlers and fails closed on unstubbed ops', async () => {
    const { interceptor } = setup();
    const served = resolveActuatorOperation('demo', 'apply_thing');
    expect(served).toMatchObject({ source: 'scenario-fixture' });
    const out = await served!.handler!(
      'apply_thing',
      { export_as: 'thing', _step_id: 'internal' },
      { before: 1 },
      'apply'
    );
    expect(out).toEqual({
      handled: true,
      ctx: { before: 1, applied: true, thing: { id: 'thing-1' } },
    });

    await expect(
      resolveActuatorOperation('demo', 'broken')!.handler!('broken', {}, {}, 'apply')
    ).rejects.toThrow('fixture failure');
    expect(() => resolveActuatorOperation('system', 'exec')).toThrow(
      '[SCENARIO_UNSTUBBED_OP] system:exec'
    );
    // Pure passthrough ops keep their normal path.
    expect(resolveActuatorOperation('system', 'log')).toMatchObject({
      source: 'actuator-op-registry',
    });
    expect(interceptor.log.ops.map((r) => [r.seq, r.op, r.stage, r.outcome])).toEqual([
      [1, 'demo:apply_thing', 'apply', 'ok'],
      [2, 'demo:broken', 'apply', 'error'],
      [3, 'system:exec', 'unstubbed', undefined],
    ]);
    expect(interceptor.log.ops[0]?.params).toEqual({ export_as: 'thing' });
  });

  it('lets provider-qualified runs fall through to real ops', () => {
    setup(
      scenario({
        lane: 'live-only',
        executionProfile: 'provider-qualified',
      })
    );
    expect(resolveActuatorOperation('system', 'exec')).toMatchObject({
      source: 'actuator-op-registry',
    });
  });

  it('answers risky approvals from seed/turn decisions and records transitions', () => {
    const { interceptor } = setup(
      scenario({ seed: { approvals: [{ op: 'secret:grant', decision: 'rejected' }] } })
    );
    expect(requireRiskyApproval({ opId: 'secret:grant', agentId: 't' })).toMatchObject({
      allowed: false,
      message: '[SCENARIO_APPROVAL_REJECTED] secret:grant',
    });
    interceptor.setApprovalDecision('secret:grant', 'approved');
    expect(requireRiskyApproval({ opId: 'secret:grant', agentId: 't' })).toEqual({
      allowed: true,
      status: 'approved',
    });
    expect(requireRiskyApproval({ opId: 'other:op', agentId: 't' })).toMatchObject({
      allowed: false,
      status: 'pending',
    });
    expect(interceptor.log.approvals.map((r) => [r.kind, r.op, r.decision, r.previous])).toEqual([
      ['requested', 'secret:grant', 'rejected', undefined],
      ['decided', 'secret:grant', 'approved', 'rejected'],
      ['requested', 'secret:grant', 'approved', undefined],
      ['requested', 'other:op', 'pending', undefined],
    ]);
  });

  it('rejects malformed seed approvals before installing anything', () => {
    const def = scenario({ seed: { approvals: [{ op: 'nope', decision: 'maybe' }] } });
    const ctx = createScenarioRunContext(def, { seedNonce: 'bad-seed' });
    expect(() => installScenarioInterceptor(ctx, def)).toThrow('[SCENARIO_INVALID_SEED_APPROVAL]');
    expect(getScenarioOpOverride()).toBeUndefined();
  });

  it('derives writes from run-root snapshots (seed files are baseline)', () => {
    const def = scenario({ seed: { files: [{ path: 'in/seed.txt', content: 'seed' }] } });
    const { interceptor, ctx } = setup(def);
    safeMkdir(path.join(ctx.runRoot, 'out'), { recursive: true });
    safeWriteFile(path.join(ctx.runRoot, 'out/report.md'), 'hello');
    safeWriteFile(path.join(ctx.runRoot, 'in/seed.txt'), 'changed');
    interceptor.snapshotWrites();
    safeUnlinkSync(path.join(ctx.runRoot, 'out/report.md'));
    interceptor.snapshotWrites();
    interceptor.snapshotWrites();

    expect(interceptor.log.writes.map((w) => [w.seq, w.path, w.change, w.bytes])).toEqual([
      [1, 'in/seed.txt', 'modified', 7],
      [2, 'out/report.md', 'created', 5],
      [3, 'out/report.md', 'deleted', undefined],
    ]);
  });

  it('dispose removes every registration and a second install then succeeds', () => {
    const def = scenario();
    const { interceptor } = setup(def);
    expect(getReasoningBackend().name).toBe('scenario-fixtures');
    const ctx2 = createScenarioRunContext(def, { seedNonce: 'second' });
    expect(() => installScenarioInterceptor(ctx2, def)).toThrow(/duplicate listener id/);
    // The failed second install rolled back and did not disturb the first.
    expect(getScenarioOpOverride()).toBeDefined();

    interceptor.dispose();
    expect(listOpPreflightListeners().map((l) => l.id)).not.toContain(SCENARIO_CAPTURE_LISTENER_ID);
    expect(getScenarioOpOverride()).toBeUndefined();
    expect(getReasoningBackend()).toBe(stubReasoningBackend);
    expect(requireRiskyApproval({ opId: 'secret:grant', agentId: 't' }).message).not.toMatch(
      /SCENARIO/
    );

    const again = installScenarioInterceptor(ctx2, def);
    again.dispose();
  });
});
