import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DotCharter } from './dot-charter.js';
import type { DotRuntimeDeps, DotWakeReceipt } from './dot-runtime.js';
import type { DotSemanticJudgmentDeps, DotSemanticBudgetOwner } from './dot-semantic-judgment.js';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const root = path.join(sourceRoot, 'active/shared/tmp', `vitest-wake-shadow-${randomUUID()}`);
let io: typeof import('../secure-io.js');
let runtime: typeof import('./dot-runtime.js');
let accounting: typeof import('../usage-accounting.js');
let latency: typeof import('../organization/judgment-latency-fixture.js');
let precedents: typeof import('../organization/judgment-precedents.js');
let validation: typeof import('../organization/judgment-validation.js');
let semantic: typeof import('../organization/semantic-judgment.js');
let evidence: typeof import('../organization/judgment-evidence.js');
let wrapper: typeof import('./dot-wake-semantic-observer.js');
let serial = 0;

function fixture(mode: 'off' | 'shadow' = 'shadow') {
  const data = latency.createJudgmentLatencyFixture();
  const result = precedents.createJudgmentPrecedentSnapshot(
    {
      scope: data.scope,
      selected_case_ids: [data.decision.case_id],
      allowed_case_ids: [data.decision.case_id],
    },
    {
      resolveCaseBinding: () => ({ case_id: data.decision.case_id, scope: data.scope }),
      readLedger: () => [data.decision],
      resolveGoals: () => [data.goal_binding],
    }
  );
  if (result.status !== 'ready') throw new Error('Fixture snapshot failed');
  const facts = latency.resolveSyntheticLatencyProposal('repair_fixture');
  if (facts.status !== 'ready') throw new Error('Fixture facts failed');
  const modelInput = validation.buildJudgmentModelInput(result.snapshot, facts.facts, [
    { evidence_key: 'synthetic-observation', text: data.untrusted_report.text },
  ]);
  const id = `wake-shadow-${++serial}`;
  const modelConfig = {
    provider: 'fixture-provider',
    model: 'fixture-model',
    maxOutputTokens: 128,
  };
  const binding = {
    schema_version: '1' as const,
    work_ref: id,
    work_revision: '1',
    trigger_key: 'fixture-observation',
    scope_hash: result.snapshot.scope_hash,
    ...validation.judgmentModelInputHashes(modelInput),
    precedent_snapshot_hash: result.snapshot.snapshot_hash,
    policy_version: 'fixture-policy',
    rubric_version: 'fixture-rubric',
    evaluator_version: 'fixture-evaluator',
    model_config_hash: semantic.semanticJudgmentModelConfigHash(modelConfig),
  };
  const request = {
    context: {
      binding,
      scope: data.scope,
      modelInput,
      snapshot: result.snapshot,
      requiredGoalKeys: [data.goal.goal_key],
      knownProposalKeys: ['repair_fixture'],
    },
    effectRef: `effect-${id}`,
    modelConfig,
  };
  const proposal = {
    title: 'Synthetic latency',
    objective: 'Prepare the bounded fixture repair',
    work_shape: 'pipeline',
    pipeline_ref: latency.SYNTHETIC_LATENCY_PIPELINE_REF,
  } as const;
  const charter: DotCharter = {
    kind: 'dot-charter',
    dot_id: id,
    version: '1.0.0',
    title: 'Offline shadow fixture',
    purpose: 'Exercise advisory observation',
    status: 'active',
    scope: data.scope,
    goal: {
      statement: 'Preserve the original constraints',
      budget: { wall_clock_ms_per_wake: 20_000, token_cap_per_day: 100_000 },
    },
    attention: { triggers: [{ kind: 'cron', cron: '*/15 * * * *' }] },
    authority: { authority_role: 'infrastructure_sentinel' },
    notification: { deliver_to: { surface: 'slack', channel: '#inert-fixture' } },
    runtime: { heartbeat_id: `dot-${id}`, semantic_judgment: { mode } },
  };
  const charterPath = path.join(root, 'dots', `${id}.json`);
  io.safeMkdir(path.dirname(charterPath), { recursive: true });
  const write = () => io.safeWriteFile(charterPath, JSON.stringify(charter));
  write();
  const loaded = { path: charterPath, charter: structuredClone(charter) };
  let time = Date.parse('2026-10-31T00:00:00.000Z');
  let next = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const now = vi.fn(() => new Date(time));
  const advance = (ms: number) => {
    time += ms;
    for (const [key, timer] of timers)
      if (timer.at <= time) {
        timers.delete(key);
        timer.run();
      }
  };
  const handles = new Map<object, { owner: DotSemanticBudgetOwner; settled: boolean }>();
  const settled: DotSemanticBudgetOwner[] = [];
  const deps: DotSemanticJudgmentDeps = {
    now: () => {
      throw new Error('Independent observer clock must not be used');
    },
    schedule: (run, delay) => {
      const key = ++next;
      timers.set(key, { at: time + delay, run });
      return () => {
        timers.delete(key);
      };
    },
    canEvaluate: vi.fn(() => true),
    prepare: vi.fn(() => ({
      request,
      requested_total_tokens: 200,
      readCurrentContext: () => ({ expectedBinding: binding, currentSnapshot: result }),
    })),
    budget: {
      mode: 'offline_fixture',
      reserve: vi.fn(({ parent, max_tokens }) => {
        const handle = Object.freeze({});
        handles.set(handle, { owner: structuredClone(parent), settled: false });
        return {
          status: 'reserved',
          handle,
          owner: structuredClone(parent),
          token_allowance: max_tokens,
        };
      }),
      holdUnknown: vi.fn((handle, owner) => {
        expect(handles.get(handle)?.owner).toEqual(owner);
        return { status: 'held_unknown' };
      }),
      settle: vi.fn((handle, owner, usage) => {
        const hold = handles.get(handle);
        if (
          !hold ||
          hold.settled ||
          precedents.judgmentCanonicalHash(hold.owner) !== precedents.judgmentCanonicalHash(owner)
        )
          throw new Error('Foreign/replayed handle');
        expect(accounting.getUsageAttribution()?.accounting_id).toBe(owner.accounting_id);
        hold.settled = true;
        settled.push(owner);
        runtime.recordDotTokenUsage(owner.dot_id, usage.input_tokens + usage.output_tokens, {
          rootDir: root,
          now: () => new Date(`${owner.day}T00:00:00.000Z`),
        });
        return { status: 'settled' };
      }),
    },
    invoke: {
      mode: 'offline_fixture',
      provider: modelConfig.provider,
      model: modelConfig.model,
      invoke: vi.fn(async () => ({
        text: JSON.stringify({
          disposition: 'apply_precedent',
          precedent_keys: result.snapshot.evidence_refs.map((ref) => ref.source_key),
          rationale: 'Preserve original constraints',
          applicability: ['Synthetic isolated repair'],
        }),
        usage: { input_tokens: 40, output_tokens: 30 },
      })),
    },
    persist: vi.fn((value, context) => evidence.saveJudgmentEvidence(value, context)),
  };
  const dispatch = vi.fn(
    (_charter: DotCharter, _proposals: readonly import('./dot-proposals.js').DotProposal[]) => []
  );
  const baselineOwners: Array<ReturnType<typeof accounting.getUsageAttribution>> = [];
  const base: DotRuntimeDeps = {
    rootDir: root,
    now,
    hasRole: () => true,
    dispatch,
    semanticJudgment: { qualification: 'offline_fixture', deps },
    backend: {
      delegateTask: async () => {
        baselineOwners.push(accounting.getUsageAttribution());
        return `\`\`\`dot-proposals\n${JSON.stringify([proposal])}\n\`\`\``;
      },
    },
  };
  const run = (tool = false) =>
    runtime.runDotWake(loaded, {
      ...base,
      ...(tool
        ? {
            runLoop: async (options: Parameters<NonNullable<DotRuntimeDeps['runLoop']>>[0]) => {
              baselineOwners.push(accounting.getUsageAttribution());
              options.executeTool!({ name: 'dot_propose_action', input: proposal });
              return {
                finalState: 'complete',
                turnsRun: 1,
                goal: { budgetStats: { tokensUsed: 10 } },
              };
            },
          }
        : {}),
    });
  return {
    loaded,
    charter,
    write,
    deps,
    base,
    run,
    now,
    advance,
    timers,
    settled,
    dispatch,
    proposal,
    baselineOwners,
    request,
  };
}
async function flush() {
  for (let n = 0; n < 30; n++) await Promise.resolve();
}

beforeAll(async () => {
  io = await import('../secure-io.js');
  io.safeMkdir(root, { recursive: true });
  const copy = (from: string, to: string): void => {
    if (io.safeLstat(from).isDirectory()) {
      io.safeMkdir(to, { recursive: true });
      for (const file of io.safeReaddir(from)) copy(path.join(from, file), path.join(to, file));
    } else io.safeCopyFileSync(from, to);
  };
  copy(
    path.join(sourceRoot, 'knowledge/product/schemas'),
    path.join(root, 'knowledge/product/schemas')
  );
  io.safeMkdir(path.join(root, 'knowledge/product/governance'), { recursive: true });
  copy(
    path.join(sourceRoot, 'knowledge/product/governance/security-policy.json'),
    path.join(root, 'knowledge/product/governance/security-policy.json')
  );
  copy(
    path.join(sourceRoot, 'knowledge/product/governance/agent-policies.yaml'),
    path.join(root, 'knowledge/product/governance/agent-policies.yaml')
  );
  io.safeWriteFile(path.join(root, 'package.json'), '{}');
  vi.stubEnv('KYBERION_ROOT', root);
  vi.stubEnv('MISSION_ROLE', 'mission_controller');
  vi.stubEnv('KYBERION_PERSONA', 'sovereign');
  vi.stubEnv('KYBERION_TENANT', 'synthetic-latency');
  io.safeMkdir(path.join(root, 'knowledge/personal/tenants'), { recursive: true });
  io.safeWriteFile(
    path.join(root, 'knowledge/personal/tenants/synthetic-latency.json'),
    JSON.stringify({
      tenant_slug: 'synthetic-latency',
      display_name: 'Synthetic fixture',
      status: 'active',
      assigned_role: 'owner',
    })
  );
  vi.resetModules();
  const { saveProjectRecord } = await import('../project/project-registry.js');
  saveProjectRecord({
    project_id: 'synthetic-project',
    name: 'Fixture',
    summary: 'Shadow fixture',
    status: 'active',
    tier: 'confidential',
    tenant_slug: 'synthetic-latency',
    organization_id: 'synthetic-org',
  } as Parameters<typeof saveProjectRecord>[0]);
  runtime = await import('./dot-runtime.js');
  accounting = await import('../usage-accounting.js');
  latency = await import('../organization/judgment-latency-fixture.js');
  precedents = await import('../organization/judgment-precedents.js');
  validation = await import('../organization/judgment-validation.js');
  semantic = await import('../organization/semantic-judgment.js');
  evidence = await import('../organization/judgment-evidence.js');
  wrapper = await import('./dot-wake-semantic-observer.js');
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  vi.unstubAllEnvs();
  io?.safeRmSync(root, { recursive: true, force: true });
  vi.resetModules();
});

describe('post-baseline offline fixture runtime observation', () => {
  it('keeps legacy deps identity and never eagerly evaluates their other getters', async () => {
    const f = fixture('off');
    const getter = vi.fn(() => 'unused');
    const deps = {
      now: f.now,
      get other() {
        return getter();
      },
    };
    await wrapper.withDotWakeSemanticObserver(f.loaded, deps, (_capture, baselineDeps) => {
      expect(baselineDeps).toBe(deps);
      return Promise.resolve({ outcome: 'delivered' });
    });
    expect(getter).not.toHaveBeenCalled();
  });
  it('fresh off never reads fixture injection, including loaded shadow -> fresh off', async () => {
    const f = fixture();
    f.charter.runtime.semantic_judgment = { mode: 'off' };
    f.write();
    const access = vi.fn(() => {
      throw new Error('Off must not read observer ports');
    });
    Object.defineProperty(f.base, 'semanticJudgment', { get: access, enumerable: true });
    // Pass the original deps directly: spreading it would intentionally evaluate the getter in test code.
    expect((await runtime.runDotWake(f.loaded, f.base)).outcome).toBe('delivered');
    expect(access).not.toHaveBeenCalled();
  });
  it('fresh shadow can enable observation despite a loaded off charter', async () => {
    const f = fixture('off');
    f.charter.runtime.semantic_judgment = { mode: 'shadow' };
    f.write();
    expect((await f.run()).outcome).toBe('delivered');
    expect(f.deps.invoke!.invoke).toHaveBeenCalledOnce();
  });
  it('derives observer time from the original method clock with its receiver', async () => {
    const f = fixture();
    f.base.now = function () {
      expect(this.rootDir).toBe(root);
      return new Date('2026-10-31T00:00:00.000Z');
    };
    expect((await runtime.runDotWake(f.loaded, f.base)).outcome).toBe('delivered');
    expect(f.deps.invoke!.invoke).toHaveBeenCalledOnce();
  });
  it('invalid parent clock disables capture while retaining the original receipt', async () => {
    const f = fixture();
    const receipt = { outcome: 'delivered' };
    const actual = await wrapper.withDotWakeSemanticObserver(
      f.loaded,
      { ...f.base, now: () => new Date(NaN) },
      (capture) => {
        capture.charter(f.charter);
        return Promise.resolve(receipt);
      }
    );
    expect(actual).toBe(receipt);
    expect(f.deps.prepare).not.toHaveBeenCalled();
  });
  it('durable off wakes can claim events without evaluating injected port getters in deps spreads', async () => {
    const f = fixture('off');
    f.charter.scope = { tier: 'public' };
    f.charter.status = 'paused';
    f.charter.attention = { triggers: [{ kind: 'event', sources: ['fixture'] }] };
    f.write();
    const lifecycle = await import('./dot-lifecycle.js');
    const intake = await import('./dot-event-intake.js');
    const enabled = lifecycle.enableDotEventContinuation(f.charter.dot_id, {
      rootDir: root,
      now: f.now,
      confirmQuiescent: true,
    });
    Object.assign(f.charter, enabled, { status: 'active' });
    f.write();
    f.loaded.charter = structuredClone(f.charter);
    const accepted = intake.ingestLocalEvent({
      source: 'fixture',
      deliveryId: f.charter.dot_id,
      body: { fixture: true },
      rootDir: root,
      now: f.now(),
      policy: {
        version: '1.0.0',
        sources: {
          fixture: {
            enabled: false,
            signature_header: 'x-signature',
            secret_key: 'EVENT_INTAKE_FIXTURE_SECRET',
            event_type_header: 'x-type',
            delivery_id_header: 'x-delivery',
            max_body_bytes: 65536,
          },
        },
      },
    });
    expect(accepted.status).toBe('accepted');
    const trigger = intake.evaluateDotEventTriggers(f.charter, { rootDir: root, now: f.now })[0];
    expect(trigger.key).toMatch(/^event:durable:/);
    const deps = { ...f.base, trigger };
    const getter = vi.fn(() => {
      throw new Error('Off getter accessed');
    });
    Object.defineProperty(deps, 'semanticJudgment', { enumerable: true, get: getter });
    expect((await runtime.runDotWake(f.loaded, deps)).outcome).toBe('delivered');
    expect(getter).not.toHaveBeenCalled();
    expect(
      runtime.readDotWakeLedger({ rootDir: root }).find((row) => row.dot_id === f.charter.dot_id)
        ?.event_attempt_id
    ).toBeTruthy();
  });
  it.each([false, true])(
    'persists the same verdict from normalized fence/tool input (tool=%s)',
    async (tool) => {
      const f = fixture();
      const artifactStore = await import('../workforce/artifact-store.js');
      const writeAttempt = artifactStore.writeScopedArtifactAttempt;
      const errors: string[] = [];
      vi.spyOn(artifactStore, 'writeScopedArtifactAttempt').mockImplementation((input) => {
        try {
          return writeAttempt(input);
        } catch (error) {
          errors.push(String(error));
          throw error;
        }
      });
      const receipt = await accounting.withUsageAttribution(
        { actor_id: 'foreign-outer', accounting_id: 'foreign-account', scope: { tier: 'public' } },
        () => f.run(tool)
      );
      expect(receipt.outcome).toBe('delivered');
      expect(f.dispatch).toHaveBeenCalledOnce();
      expect(f.deps.persist).toHaveBeenCalledOnce();
      const saved = vi.mocked(f.deps.persist!).mock.results[0].value;
      expect(saved, JSON.stringify({ saved, errors })).toMatchObject({ status: 'persisted' });
      if (saved.status !== 'persisted') throw new Error('Expected persisted fixture receipt');
      expect(saved.assessment.verdict.disposition).toBe('apply_precedent');
      expect(f.settled[0].accounting_id).toBe(f.baselineOwners[0]?.accounting_id);
      expect(f.settled[0].accounting_id).not.toBe('foreign-account');
      expect(f.settled[0].day).toBe('2026-10-31');
      expect(f.settled[0].scope_hash).toBe(f.request.context.binding.scope_hash);
      const prepareCall = vi.mocked(f.deps.prepare!).mock.calls[0];
      expect(prepareCall[0]).toEqual(f.dispatch.mock.calls[0][1][0]);
      expect(prepareCall[1].deadline_ms).toBe(Date.parse('2026-10-31T00:00:20.000Z'));
      expect(f.timers.size).toBe(0);
    }
  );
  it('takes detached proposal facts before a dispatch adapter mutates them', async () => {
    const f = fixture();
    f.base.dispatch = (_charter, proposals) => {
      proposals[0].title = 'Changed by baseline dispatch';
      return [];
    };
    expect((await f.run()).outcome).toBe('delivered');
    expect(vi.mocked(f.deps.prepare!).mock.calls[0][0].title).toBe(f.proposal.title);
  });
  it.each(['pause', 'policy', 'expired', 'regressed-clock'] as const)(
    'skips after baseline %s without preparation or inference',
    async (change) => {
      const f = fixture();
      f.base.dispatch = () => {
        if (change === 'pause') f.charter.status = 'paused';
        if (change === 'policy') f.charter.purpose = 'Changed policy context';
        if (change === 'expired') f.advance(20_000);
        if (change === 'regressed-clock') f.advance(-1);
        f.write();
        return [];
      };
      expect((await f.run()).outcome).toBe('delivered');
      expect(f.deps.prepare).not.toHaveBeenCalled();
      expect(f.deps.invoke!.invoke).not.toHaveBeenCalled();
    }
  );
  it('missing parent deadline or qualified ports never prepares or invokes', async () => {
    const f = fixture();
    delete f.charter.goal.budget!.wall_clock_ms_per_wake;
    f.write();
    expect((await f.run()).outcome).toBe('delivered');
    expect(f.deps.prepare).not.toHaveBeenCalled();
    const g = fixture();
    g.base.semanticJudgment = undefined;
    expect((await g.run()).outcome).toBe('delivered');
    expect(g.deps.prepare).not.toHaveBeenCalled();
  });
  it.each(['prepare', 'persist'] as const)(
    'advisory %s failure preserves baseline receipt and dispatch counts',
    async (failure) => {
      const f = fixture();
      f.deps[failure] = vi.fn(() => {
        throw new Error('Fixture failure');
      });
      const receipt = await f.run();
      expect(receipt).toEqual({
        dot_id: f.charter.dot_id,
        outcome: 'delivered',
        reason: 'delegated-turn',
        actions: [],
      });
      expect(f.dispatch).toHaveBeenCalledOnce();
      expect(
        runtime
          .readDotWakeLedger({ rootDir: root })
          .filter((row) => row.dot_id === f.charter.dot_id)
      ).toHaveLength(1);
      if (failure === 'persist') expect(f.settled).toHaveLength(1);
    }
  );
  it('bounds never-ACK observer waits, releases wake guard first, and never persists late', async () => {
    const f = fixture();
    let resolve!: (value: {
      text: string;
      usage: { input_tokens: number; output_tokens: number };
    }) => void;
    f.deps.invoke!.invoke = vi.fn(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const pending = f.run();
    await flush();
    expect(f.deps.invoke!.invoke).toHaveBeenCalledOnce();
    f.charter.runtime.semantic_judgment = { mode: 'off' };
    f.write();
    expect((await f.run()).outcome).toBe('delivered'); // Baseline's process guard already released.
    f.advance(15_000);
    await flush();
    expect((await pending).outcome).toBe('delivered');
    expect(f.deps.budget!.holdUnknown).toHaveBeenCalledOnce();
    expect(f.deps.persist).not.toHaveBeenCalled();
    resolve({ text: '{}', usage: { input_tokens: 40, output_tokens: 30 } });
    await flush();
    expect(f.settled).toHaveLength(1);
    expect(f.deps.persist).not.toHaveBeenCalled();
  });
  it('preserves baseline receipt object identity and ignores capture failures', async () => {
    const f = fixture();
    const receipt: DotWakeReceipt = {
      dot_id: f.charter.dot_id,
      outcome: 'delivered',
      reason: 'fixture',
      actions: [],
    };
    const deps = {
      get semanticJudgment(): never {
        throw new Error('Invalid injection getter');
      },
    };
    expect(
      await wrapper.withDotWakeSemanticObserver(f.loaded, deps, (capture) => {
        capture.charter(f.charter);
        return Promise.resolve(receipt);
      })
    ).toBe(receipt);
  });
});
