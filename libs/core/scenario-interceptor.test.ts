import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getScenarioOpOverride,
  isScenarioApprovalGranted,
  resolveActuatorOperation,
} from './actuator-op-registry.js';
import { listOpPreflightListeners, registerOpGuard, runOpPreflight } from './op-preflight.js';
import {
  getReasoningBackend,
  registerReasoningBackend,
  resetReasoningBackend,
  stubReasoningBackend,
} from './reasoning-backend.js';
import type { ReasoningBackend } from './reasoning-backend-contracts.js';
import { requireRiskyApproval } from './risky-op-approval-port.js';
import { parseScenarioDefinition, type ScenarioDefinition } from './scenario-definition.js';
import {
  installScenarioInterceptor,
  SCENARIO_CAPTURE_LISTENER_ID,
  type ScenarioInterceptor,
} from './scenario-interceptor.js';
import { createScenarioRunContext, type ScenarioRunContext } from './scenario-run-context.js';
import { runServingScenarioFixture } from './scenario-run-scope.js';
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
    const result = await interceptor.runInScope(() =>
      runOpPreflight({
        op: 'demo:apply_thing',
        params: { target: 'x', api_key: 'sk-abcdefghijklmnopqrstuvwx' },
        source: 'pipeline',
      })
    );
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
        admitted: true,
      },
    ]);

    // Approval-required and not granted: the built-in guard still asks.
    const gated = await interceptor.runInScope(() =>
      runOpPreflight({
        op: 'demo:apply_thing',
        params: {},
        source: 'pipeline',
        requiresApproval: true,
        approvalGranted: false,
      })
    );
    expect(gated.decision).toBe('ask');
    expect(interceptor.log.ops[1]?.admitted).toBeUndefined();
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

  it('never marks a call admitted when a later-ordered guard blocks it (N6)', async () => {
    const { interceptor } = setup();
    // A guard ordered after Number.MAX_SAFE_INTEGER (e.g. Infinity, or same
    // order with a lexicographically later id such as a plugin guard's
    // `${pluginId}:${name}`) used to run after the old admission guard and
    // leave the record incorrectly marked `admitted`.
    const dispose = registerOpGuard({
      id: 'late-blocker',
      order: Number.POSITIVE_INFINITY,
      check: () => ({ decision: 'block', reason: 'late block' }),
    });
    try {
      const result = await interceptor.runInScope(() =>
        runOpPreflight({ op: 'demo:apply_thing', params: {}, source: 'pipeline' })
      );
      expect(result.decision).toBe('block');
      expect(interceptor.log.ops[0]?.admitted).toBeUndefined();
    } finally {
      dispose();
    }
  });

  it('serves fixtures without touching real handlers and fails closed on unstubbed ops', async () => {
    const { interceptor } = setup();
    await interceptor.runInScope(async () => {
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
  });

  it('lets provider-qualified runs fall through to real ops', () => {
    const { interceptor } = setup(
      scenario({
        lane: 'live-only',
        executionProfile: 'provider-qualified',
      })
    );
    expect(interceptor.runInScope(() => resolveActuatorOperation('system', 'exec'))).toMatchObject({
      source: 'actuator-op-registry',
    });
  });

  it('answers risky approvals from seed/turn decisions and records transitions', () => {
    const base = scenario();
    const { interceptor } = setup(
      scenario({
        seed: { approvals: [{ op: 'secret:grant', decision: 'rejected' }] },
        fixtures: { ops: { ...base.fixtures.ops, 'secret:grant': { result: { ok: true } } } },
      })
    );
    const ask = (opId: string) =>
      interceptor.runInScope(() =>
        runServingScenarioFixture(opId, () => requireRiskyApproval({ opId, agentId: 't' }))
      );
    expect(ask('secret:grant')).toMatchObject({
      allowed: false,
      message: '[SCENARIO_APPROVAL_REJECTED] secret:grant',
    });
    interceptor.setApprovalDecision('secret:grant', 'approved');
    expect(ask('secret:grant')).toEqual({ allowed: true, status: 'approved' });
    expect(ask('other:op')).toMatchObject({ allowed: false, status: 'pending' });
    expect(interceptor.log.approvals.map((r) => [r.kind, r.op, r.decision, r.previous])).toEqual([
      ['requested', 'secret:grant', 'rejected', undefined],
      ['decided', 'secret:grant', 'approved', 'rejected'],
      ['requested', 'secret:grant', 'approved', undefined],
      ['requested', 'other:op', 'pending', undefined],
    ]);
  });

  it('never grants a risky approval for an op no fixture serves', () => {
    const { interceptor } = setup(
      scenario({ seed: { approvals: [{ op: 'secret:grant', decision: 'approved' }] } })
    );
    expect(
      interceptor.runInScope(() =>
        runServingScenarioFixture('secret:grant', () =>
          requireRiskyApproval({ opId: 'secret:grant', agentId: 't' })
        )
      )
    ).toMatchObject({
      allowed: false,
      status: 'pending',
      message: expect.stringContaining('[SCENARIO_APPROVAL_UNFIXTURED] secret:grant'),
    });
  });

  it('never grants an in-scope risky approval that no fixture dispatch raised (FU-01)', () => {
    const base = scenario();
    const { interceptor } = setup(
      scenario({
        seed: { approvals: [{ op: 'secret:grant', decision: 'approved' }] },
        fixtures: { ops: { ...base.fixtures.ops, 'secret:grant': { result: { ok: true } } } },
      })
    );
    const unfixtured = expect.stringContaining('[SCENARIO_APPROVAL_UNFIXTURED] secret:grant');
    // Same op id, but raised by host code inside the turn rather than by the fixture.
    expect(
      interceptor.runInScope(() => requireRiskyApproval({ opId: 'secret:grant', agentId: 't' }))
    ).toMatchObject({ allowed: false, status: 'pending', message: unfixtured });
    // Raised while a different fixture op is being served.
    expect(
      interceptor.runInScope(() =>
        runServingScenarioFixture('demo:apply_thing', () =>
          requireRiskyApproval({ opId: 'secret:grant', agentId: 't' })
        )
      )
    ).toMatchObject({ allowed: false, message: unfixtured });
  });

  it('defers risky approvals to the canonical handler outside the simulated profile', () => {
    const base = scenario();
    const { interceptor } = setup(
      scenario({
        lane: 'live-only',
        executionProfile: 'provider-qualified',
        seed: { approvals: [{ op: 'secret:grant', decision: 'approved' }] },
        fixtures: { ops: { ...base.fixtures.ops, 'secret:grant': { result: { ok: true } } } },
      })
    );
    const answer = interceptor.runInScope(() =>
      runServingScenarioFixture('secret:grant', () =>
        requireRiskyApproval({ opId: 'secret:grant', agentId: 't' })
      )
    );
    expect(answer.allowed).toBe(false);
    expect(answer.message ?? '').not.toMatch(/SCENARIO/);
    expect(interceptor.log.approvals.map((r) => [r.channel, r.op, r.decision])).toEqual([
      ['risky-approval', 'secret:grant', 'approved'],
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
    expect(interceptor.runInScope(() => getReasoningBackend().name)).toBe('scenario-fixtures');
    const ctx2 = createScenarioRunContext(def, { seedNonce: 'second' });
    expect(() => installScenarioInterceptor(ctx2, def)).toThrow(/duplicate listener id/);
    // The failed second install rolled back and did not disturb the first.
    expect(getScenarioOpOverride()).toBeDefined();

    interceptor.dispose();
    expect(listOpPreflightListeners().map((l) => l.id)).not.toContain(SCENARIO_CAPTURE_LISTENER_ID);
    expect(getScenarioOpOverride()).toBeUndefined();
    expect(getReasoningBackend()).toBe(stubReasoningBackend);
    expect(
      interceptor.runInScope(
        () => requireRiskyApproval({ opId: 'secret:grant', agentId: 't' }).message
      )
    ).not.toMatch(/SCENARIO/);

    const again = installScenarioInterceptor(ctx2, def);
    again.dispose();
  });
});

describe('scenario scope isolation (FU-01)', () => {
  function probe() {
    let resolution: string;
    try {
      resolution = resolveActuatorOperation('system', 'exec')?.source ?? 'none';
    } catch (error) {
      resolution = (error as Error).message.slice(0, 24);
    }
    return {
      resolution,
      fixtureApproval: isScenarioApprovalGranted('secret', 'grant'),
      riskyApproval: runServingScenarioFixture('secret:grant', () =>
        requireRiskyApproval({ opId: 'secret:grant', agentId: 't' })
      ),
      backend: getReasoningBackend().name,
    };
  }

  function isolationSetup() {
    const prior = { ...stubReasoningBackend, name: 'prior-backend' } as ReasoningBackend;
    registerReasoningBackend(prior, { provenance: 'builtin', source: 'test' });
    const base = scenario();
    const installed = setup(
      scenario({
        seed: { approvals: [{ op: 'secret:grant', decision: 'approved' }] },
        fixtures: { ops: { ...base.fixtures.ops, 'secret:grant': { result: { ok: true } } } },
      })
    );
    cleanups.push(() => resetReasoningBackend());
    return installed;
  }

  it('a concurrent out-of-scope task sees normal ops, canonical approval and the prior backend', async () => {
    const { interceptor } = isolationSetup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Started outside the run: host work that happens to overlap it.
    const outside = (async () => {
      await gate;
      const seen = probe();
      await runOpPreflight({ op: 'demo:apply_thing', params: {}, source: 'pipeline' });
      const reply = await getReasoningBackend().prompt('host question');
      return { ...seen, reply };
    })();

    const inside = await interceptor.runInScope(async () => {
      release();
      const seenOutside = await outside;
      return { seen: probe(), seenOutside };
    });

    expect(inside.seenOutside).toMatchObject({
      resolution: 'actuator-op-registry',
      fixtureApproval: false,
      riskyApproval: { allowed: false, message: 'Approval gate is not registered' },
      backend: 'prior-backend',
    });
    expect(inside.seenOutside.reply).toEqual(expect.any(String));
    expect(inside.seen).toMatchObject({
      resolution: '[SCENARIO_UNSTUBBED_OP] ',
      fixtureApproval: true,
      riskyApproval: { allowed: true, status: 'approved' },
      backend: 'scenario-fixtures',
    });
    // Out-of-scope preflight and approval calls were not recorded.
    expect(interceptor.log.ops.map((r) => [r.op, r.stage])).toEqual([['system:exec', 'unstubbed']]);
    expect(interceptor.log.approvals.map((r) => r.op)).toEqual(['secret:grant']);
    expect(interceptor.log.reasoning).toEqual([]);
    // ...but surfaced as scope_lost (approval probes are not dispatches).
    expect(interceptor.log.warnings.map((r) => [r.kind, r.op, r.source])).toEqual([
      ['scope_lost', 'system:exec', 'op-dispatch'],
      ['scope_lost', 'demo:apply_thing', 'pipeline'],
    ]);
  });

  it('records no scope_lost warning outside the simulated profile', async () => {
    const { interceptor } = setup(
      scenario({ lane: 'live-only', executionProfile: 'provider-qualified' })
    );
    resolveActuatorOperation('system', 'exec');
    await runOpPreflight({ op: 'demo:apply_thing', params: {}, source: 'pipeline' });
    expect(interceptor.log.warnings).toEqual([]);
  });

  it('keeps nested async work started inside a turn in scope', async () => {
    const { interceptor } = isolationSetup();
    const results = await interceptor.runInScope(async () => {
      await Promise.resolve();
      const nested = await Promise.all([
        (async () => {
          await new Promise<void>((resolve) => setImmediate(resolve));
          return probe();
        })(),
        new Promise<ReturnType<typeof probe>>((resolve) => queueMicrotask(() => resolve(probe()))),
      ]);
      await expect(getReasoningBackend().prompt('in scope')).rejects.toThrow(
        '[SCENARIO_MODEL_CALL_FORBIDDEN]'
      );
      return nested;
    });
    for (const seen of results) {
      expect(seen).toMatchObject({
        resolution: '[SCENARIO_UNSTUBBED_OP] ',
        fixtureApproval: true,
        backend: 'scenario-fixtures',
      });
    }
  });
});
