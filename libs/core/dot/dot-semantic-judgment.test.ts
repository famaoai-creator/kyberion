import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DotProposal } from './dot-proposals.js';
import type {
  DotSemanticBudgetOwner,
  DotSemanticJudgmentDeps,
  DotSemanticJudgmentInput,
  DotSemanticKnownUsage,
  DotSemanticSharedBudgetPort,
  PreparedDotSemanticJudgment,
} from './dot-semantic-judgment.js';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtureRoot = path.join(
  sourceRoot,
  'active/shared/tmp',
  `vitest-dot-semantic-${randomUUID()}`
);
let bootstrapIo: typeof import('../secure-io.js');
let observer: typeof import('./dot-semantic-judgment.js');
let runtime: typeof import('./dot-runtime.js');
let accounting: typeof import('../usage-accounting.js');
let events: typeof import('../event-scope.js');
let latency: typeof import('../organization/judgment-latency-fixture.js');
let precedents: typeof import('../organization/judgment-precedents.js');
let validation: typeof import('../organization/judgment-validation.js');
let semantic: typeof import('../organization/semantic-judgment.js');
let evidence: typeof import('../organization/judgment-evidence.js');
let json: typeof import('../foundation/json.js');
let sequence = 0;

class Clock {
  time = Date.parse('2026-10-31T00:00:00.000Z');
  private next = 0;
  private timers = new Map<number, { at: number; run: () => void }>();
  now = (): number => this.time;
  schedule = (run: () => void, delay: number): (() => void) => {
    const id = ++this.next;
    this.timers.set(id, { at: this.time + delay, run });
    return () => {
      this.timers.delete(id);
    };
  };
  advance(ms: number) {
    this.time += ms;
    for (const [id, timer] of this.timers)
      if (timer.at <= this.time) {
        this.timers.delete(id);
        timer.run();
      }
  }
  get pending() {
    return this.timers.size;
  }
}
async function flush() {
  for (let index = 0; index < 10; index++) await Promise.resolve();
}

function fixture() {
  const data = latency.createJudgmentLatencyFixture();
  const snapshot = precedents.createJudgmentPrecedentSnapshot(
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
  if (snapshot.status !== 'ready') throw new Error('Invalid shared fixture');
  const facts = latency.resolveSyntheticLatencyProposal('repair_fixture');
  if (facts.status !== 'ready') throw new Error('Invalid fixture operation');
  const modelInput = validation.buildJudgmentModelInput(snapshot.snapshot, facts.facts, [
    { evidence_key: 'synthetic-observation', text: data.untrusted_report.text },
  ]);
  const clock = new Clock();
  const serial = ++sequence;
  const modelConfig = {
    provider: 'fixture-provider',
    model: 'fixture-model',
    maxOutputTokens: 128,
  };
  const binding = {
    schema_version: '1' as const,
    work_ref: `shadow-work-${serial}`,
    work_revision: '1',
    trigger_key: 'fixture-observation',
    scope_hash: snapshot.snapshot.scope_hash,
    ...validation.judgmentModelInputHashes(modelInput),
    precedent_snapshot_hash: snapshot.snapshot.snapshot_hash,
    policy_version: 'fixture-policy',
    rubric_version: 'fixture-rubric',
    evaluator_version: 'fixture-evaluator',
    model_config_hash: semantic.semanticJudgmentModelConfigHash(modelConfig),
  };
  const proposal: DotProposal = {
    action_id: 'dot_delegate_work',
    title: 'Synthetic latency',
    objective: 'Prepare the bounded fixture repair',
    work_shape: 'pipeline',
    pipeline_ref: latency.SYNTHETIC_LATENCY_PIPELINE_REF,
  };
  const input: DotSemanticJudgmentInput = {
    mode: 'shadow',
    parent: {
      dot_id: `shadow-dot-${serial}`,
      accounting_id: `wake-account-${serial}`,
      scope: structuredClone(data.scope),
      day: '2026-10-31',
      deadline_ms: clock.time + 60_000,
      baseline_complete: true,
    },
    proposals: [proposal],
  };
  const owner: DotSemanticBudgetOwner = {
    dot_id: input.parent.dot_id,
    accounting_id: input.parent.accounting_id,
    scope_hash: binding.scope_hash,
    day: input.parent.day,
  };
  const prepared: PreparedDotSemanticJudgment = {
    request: {
      context: {
        binding,
        scope: data.scope,
        modelInput,
        snapshot: snapshot.snapshot,
        requiredGoalKeys: [data.goal.goal_key],
        knownProposalKeys: ['repair_fixture'],
      },
      effectRef: `effect-${serial}`,
      modelConfig,
    },
    requested_total_tokens: 200,
    readCurrentContext: () => ({ expectedBinding: binding, currentSnapshot: snapshot }),
  };
  const inOwner = <T>(who: DotSemanticBudgetOwner, fn: () => T): T =>
    accounting.withUsageAttribution(
      { actor_id: `dot:${who.dot_id}`, accounting_id: who.accounting_id, scope: data.scope },
      fn
    );
  const spent = () =>
    runtime.dotTokensUsedToday(input.parent.dot_id, {
      rootDir: fixtureRoot,
      now: () => new Date(`${owner.day}T00:00:00.000Z`),
    });
  const charge = (who: DotSemanticBudgetOwner, tokens: number) => {
    const current = accounting.getUsageAttribution();
    expect(current?.actor_id).toBe(`dot:${who.dot_id}`);
    expect(current?.accounting_id).toBe(who.accounting_id);
    expect(current?.scope).toEqual(events.normalizeEventScope(data.scope));
    runtime.recordDotTokenUsage(who.dot_id, tokens, {
      rootDir: fixtureRoot,
      // Fixture policy pins late charges to the original parent's reserved billing day.
      // This is not a claim that real provider metrics already support such reconciliation.
      now: () => new Date(`${who.day}T00:00:00.000Z`),
    });
  };
  // The fixture's ordinary consumer and judge share this ONE parent ledger/cap/hold manager.
  // This in-memory issuer is NOT a production durable reservation implementation.
  type Hold = {
    owner: DotSemanticBudgetOwner;
    max: number;
    state: 'reserved' | 'unknown' | 'settled';
    finalHash?: string;
  };
  const holds = new Map<object, Hold>();
  const keys = new Set<string>();
  const parents = new Set([precedents.judgmentCanonicalHash(owner)]);
  const assertOwner = (handle: object, who: DotSemanticBudgetOwner): Hold => {
    const state = holds.get(handle);
    if (
      !state ||
      precedents.judgmentCanonicalHash(state.owner) !== precedents.judgmentCanonicalHash(who)
    )
      throw new Error('Foreign reservation handle');
    return state;
  };
  const budget: DotSemanticSharedBudgetPort = {
    mode: 'offline_fixture',
    reserve: vi.fn(({ parent, reservation_key, max_tokens }) => {
      if (!parents.has(precedents.judgmentCanonicalHash(parent))) return { status: 'unavailable' };
      const reserved = [...holds.values()]
        .filter((hold) => hold.state !== 'settled')
        .reduce((sum, hold) => sum + hold.max, 0);
      if (keys.has(reservation_key) || spent() + reserved + max_tokens > 1000)
        return { status: 'unavailable' };
      const handle = Object.freeze({});
      keys.add(reservation_key);
      holds.set(handle, { owner: structuredClone(parent), max: max_tokens, state: 'reserved' });
      return {
        status: 'reserved',
        handle,
        owner: structuredClone(parent),
        token_allowance: max_tokens,
      };
    }),
    holdUnknown: vi.fn((handle, who) => {
      const hold = assertOwner(handle, who);
      if (hold.state === 'settled') throw new Error('Final reservation cannot become unknown');
      hold.state = 'unknown';
      return { status: 'held_unknown' };
    }),
    settle: vi.fn((handle, who, usage) => {
      const hold = assertOwner(handle, who);
      const digest = precedents.judgmentCanonicalHash(usage);
      if (hold.state === 'settled') {
        if (hold.finalHash !== digest) throw new Error('Changed final usage');
        return { status: 'settled' };
      }
      charge(who, usage.input_tokens + usage.output_tokens);
      hold.state = 'settled';
      hold.finalHash = digest;
      return { status: 'settled' };
    }),
  };
  inOwner(owner, () => charge(owner, 100)); // Baseline usage was settled before observer admission.
  let active = true;
  const verdict = {
    disposition: 'apply_precedent',
    precedent_keys: snapshot.snapshot.evidence_refs.map((ref) => ref.source_key),
    rationale: 'Preserve the original fixture goal',
    applicability: ['Isolated zero-cost fixture repair'],
  };
  const response = () => ({
    text: JSON.stringify(verdict),
    usage: { input_tokens: 40, output_tokens: 30 },
  });
  const deps: DotSemanticJudgmentDeps = {
    now: clock.now,
    schedule: clock.schedule,
    canEvaluate: vi.fn(() => active),
    prepare: vi.fn(() => prepared),
    budget,
    invoke: {
      mode: 'offline_fixture',
      provider: modelConfig.provider,
      model: modelConfig.model,
      invoke: vi.fn(async () => {
        const current = accounting.getUsageAttribution();
        expect(current?.accounting_id).toBe(owner.accounting_id);
        expect(current?.scope).toEqual(events.normalizeEventScope(data.scope));
        return response();
      }),
    },
    persist: vi.fn((request, context) => evidence.saveJudgmentEvidence(request, context)),
  };
  return {
    input,
    deps,
    clock,
    prepared,
    owner,
    budget,
    holds,
    spent,
    inOwner,
    response,
    parents,
    pause: () => {
      active = false;
    },
  };
}

describe('contract-only dot semantic observer (no production reservation/provider adapter)', () => {
  beforeAll(async () => {
    bootstrapIo = await import('../secure-io.js');
    bootstrapIo.safeMkdir(fixtureRoot, { recursive: true });
    function copy(source: string, destination: string): void {
      if (bootstrapIo.safeLstat(source).isDirectory()) {
        bootstrapIo.safeMkdir(destination, { recursive: true });
        for (const entry of bootstrapIo.safeReaddir(source))
          copy(path.join(source, entry), path.join(destination, entry));
      } else bootstrapIo.safeCopyFileSync(source, destination);
    }
    copy(
      path.join(sourceRoot, 'knowledge/product/schemas'),
      path.join(fixtureRoot, 'knowledge/product/schemas')
    );
    bootstrapIo.safeMkdir(path.join(fixtureRoot, 'knowledge/product/governance'), {
      recursive: true,
    });
    copy(
      path.join(sourceRoot, 'knowledge/product/governance/agent-policies.yaml'),
      path.join(fixtureRoot, 'knowledge/product/governance/agent-policies.yaml')
    );
    bootstrapIo.safeWriteFile(path.join(fixtureRoot, 'package.json'), '{}');
    vi.stubEnv('KYBERION_ROOT', fixtureRoot);
    vi.stubEnv('MISSION_ROLE', 'mission_controller');
    vi.resetModules();
    const { saveProjectRecord } = await import('../project/project-registry.js');
    saveProjectRecord({
      project_id: 'synthetic-project',
      name: 'Fixture',
      summary: 'Observer test',
      status: 'active',
      tier: 'confidential',
      tenant_slug: 'synthetic-latency',
      organization_id: 'synthetic-org',
    } as Parameters<typeof saveProjectRecord>[0]);
    observer = await import('./dot-semantic-judgment.js');
    runtime = await import('./dot-runtime.js');
    accounting = await import('../usage-accounting.js');
    events = await import('../event-scope.js');
    latency = await import('../organization/judgment-latency-fixture.js');
    precedents = await import('../organization/judgment-precedents.js');
    validation = await import('../organization/judgment-validation.js');
    semantic = await import('../organization/semantic-judgment.js');
    evidence = await import('../organization/judgment-evidence.js');
    json = await import('../foundation/json.js');
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => {
    vi.unstubAllEnvs();
    bootstrapIo?.safeRmSync(fixtureRoot, { recursive: true, force: true });
    vi.resetModules();
  });

  it('does absolutely no preparation, admission, provider or persistence work in off mode', async () => {
    const f = fixture();
    f.input.mode = 'off';
    expect(await observer.observeDotSemanticJudgment(f.input, f.deps)).toEqual([]);
    expect(f.deps.canEvaluate).not.toHaveBeenCalled();
    expect(f.deps.prepare).not.toHaveBeenCalled();
    expect(f.budget.reserve).not.toHaveBeenCalled();
    expect(f.deps.invoke!.invoke).not.toHaveBeenCalled();
    expect(f.deps.persist).not.toHaveBeenCalled();
    expect(f.spent()).toBe(100);
  });

  it.each(['budget', 'invoke', 'persist', 'prepare', 'canEvaluate', 'schedule'] as const)(
    'missing qualified %s port does not even prepare or resolve a provider',
    async (missing) => {
      const f = fixture();
      const deps = { ...f.deps, [missing]: undefined };
      expect(await observer.observeDotSemanticJudgment(f.input, deps)).toMatchObject([
        { reason: 'qualified_ports_unavailable', additional_model_calls: 0 },
      ]);
      expect(f.deps.prepare).not.toHaveBeenCalled();
      expect(f.budget.reserve).not.toHaveBeenCalled();
      expect(f.deps.invoke!.invoke).not.toHaveBeenCalled();
    }
  );

  it('uses real T04/T05 contracts and charges the same actual parent ledger/accounting identity', async () => {
    const f = fixture();
    const before = structuredClone(f.input);
    const result = await observer.observeDotSemanticJudgment(f.input, f.deps);
    expect(result).toMatchObject([
      {
        status: 'observed',
        budget_status: 'settled',
        additional_model_calls: 1,
        usage: { input_tokens: 40, output_tokens: 30 },
      },
    ]);
    expect(f.spent()).toBe(170);
    expect(f.input).toEqual(before);
    expect(f.clock.pending).toBe(0);
    const rows = json
      .readJsonLines<{ dot_id: string; accounting_id: string; tokens: number }>(
        path.join(fixtureRoot, runtime.DOT_TOKEN_USAGE_PATH)
      )
      .filter((row) => row.dot_id === f.owner.dot_id);
    expect(rows.map((row) => row.tokens)).toEqual([100, 70]);
    expect(rows.every((row) => row.accounting_id === f.owner.accounting_id)).toBe(true);
    expect(result[0]).not.toHaveProperty('actions');
    expect(Object.keys(f.deps).sort()).toEqual([
      'budget',
      'canEvaluate',
      'invoke',
      'now',
      'persist',
      'prepare',
      'schedule',
    ]);
  });

  it('never creates a judge wallet when an ordinary consumer already holds the shared remainder', async () => {
    const f = fixture();
    const ordinary = { ...f.owner, accounting_id: 'ordinary-parent-wake' };
    f.parents.add(precedents.judgmentCanonicalHash(ordinary));
    f.inOwner(ordinary, () =>
      f.budget.reserve({
        parent: ordinary,
        reservation_key: 'ordinary-reservation',
        max_tokens: 850,
      })
    );
    const result = await observer.observeDotSemanticJudgment(f.input, f.deps);
    expect(result).toMatchObject([
      { status: 'skipped', reason: 'shared_parent_budget_unavailable', additional_model_calls: 0 },
    ]);
    expect(f.deps.invoke!.invoke).not.toHaveBeenCalled();
    expect(f.spent()).toBe(100);
  });

  it('treats a duplicate reservation as unavailable rather than granting a second invocation', async () => {
    const f = fixture();
    await observer.observeDotSemanticJudgment(f.input, f.deps);
    expect(await observer.observeDotSemanticJudgment(f.input, f.deps)).toMatchObject([
      { reason: 'shared_parent_budget_unavailable' },
    ]);
    expect(f.deps.invoke!.invoke).toHaveBeenCalledTimes(1);
    expect(f.spent()).toBe(170);
  });

  it('keeps unknown provider usage held rather than pretending cancellation or failure cost zero', async () => {
    const f = fixture();
    f.deps.invoke!.invoke = vi.fn(async () => {
      throw new Error('Secret provider failure');
    });
    const result = await observer.observeDotSemanticJudgment(f.input, f.deps);
    expect(result).toMatchObject([
      {
        status: 'unavailable',
        budget_status: 'held_unknown',
        additional_model_calls: 1,
        usage: { input_tokens: null, output_tokens: null },
      },
    ]);
    expect([...f.holds.values()][0].state).toBe('unknown');
    expect(f.budget.settle).not.toHaveBeenCalled();
    expect(f.deps.persist).not.toHaveBeenCalled();
    expect(f.spent()).toBe(100);
    expect(JSON.stringify(result)).not.toContain('Secret');
  });

  it('accounts malformed output and receipt failure without changing the completed baseline', async () => {
    const f = fixture();
    f.deps.invoke!.invoke = vi.fn(async () => ({
      text: '{broken',
      usage: { input_tokens: 40, output_tokens: 30 },
    }));
    expect(await observer.observeDotSemanticJudgment(f.input, f.deps)).toMatchObject([
      { status: 'unavailable', reason: 'invalid_schema', budget_status: 'settled' },
    ]);
    expect(f.spent()).toBe(170);
    expect(f.deps.persist).not.toHaveBeenCalled();
    const second = fixture();
    second.deps.persist = vi.fn(() => {
      throw new Error('Secret store failure');
    });
    const result = await observer.observeDotSemanticJudgment(second.input, second.deps);
    expect(result).toMatchObject([{ reason: 'receipt_failed', budget_status: 'settled' }]);
    expect(second.spent()).toBe(170);
    expect(JSON.stringify(result)).not.toContain('Secret');
  });

  it('does not infer zero new usage merely because persistence adopts an older valid receipt', async () => {
    const f = fixture();
    await observer.observeDotSemanticJudgment(f.input, f.deps);
    f.input.parent.accounting_id = 'another-parent-attempt';
    f.owner.accounting_id = f.input.parent.accounting_id;
    f.parents.add(precedents.judgmentCanonicalHash(f.owner));
    const result = await observer.observeDotSemanticJudgment(f.input, f.deps);
    expect(result).toMatchObject([
      {
        status: 'observed',
        additional_model_calls: 1,
        usage: { input_tokens: 40, output_tokens: 30 },
      },
    ]);
    expect(f.spent()).toBe(240);
    expect(f.deps.invoke!.invoke).toHaveBeenCalledTimes(2);
  });

  it('returns within the deadline for a broken never-ack provider while retaining the full unknown hold', async () => {
    const f = fixture();
    f.deps.invoke!.invoke = vi.fn(() => new Promise(() => undefined));
    const pending = observer.observeDotSemanticJudgment(f.input, f.deps);
    expect(f.deps.invoke!.invoke).toHaveBeenCalledTimes(1);
    f.clock.advance(15_000);
    const result = await pending;
    expect(result).toMatchObject([
      {
        status: 'pending_stop',
        reason: 'observer_deadline',
        stop_confirmed: false,
        budget_status: 'held_unknown',
        additional_model_calls: 1,
      },
    ]);
    expect(f.budget.settle).not.toHaveBeenCalled();
    expect(f.deps.persist).not.toHaveBeenCalled();
    expect([...f.holds.values()][0].state).toBe('unknown');
    expect(f.clock.pending).toBe(0);
  });

  it('settles late reported usage exactly once after timeout and never persists the late assessment', async () => {
    const f = fixture();
    let acknowledge: ((value: ReturnType<typeof f.response>) => void) | undefined;
    f.deps.invoke!.invoke = vi.fn(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        })
    );
    const pending = observer.observeDotSemanticJudgment(f.input, f.deps);
    f.clock.advance(15_000);
    await pending;
    expect(f.budget.holdUnknown).toHaveBeenCalledTimes(1);
    expect(f.spent()).toBe(100);
    acknowledge!(f.response());
    await flush();
    expect(f.spent()).toBe(170);
    expect(f.budget.settle).toHaveBeenCalledTimes(1);
    expect(f.deps.persist).not.toHaveBeenCalled();
    expect([...f.holds.values()][0].state).toBe('settled');
    expect(f.clock.pending).toBe(0);
  });

  it('captures the validated handle identity and allowance even if the issuer mutates its result container', async () => {
    const f = fixture();
    const reserve = f.budget.reserve;
    let issued:
      | Extract<ReturnType<DotSemanticSharedBudgetPort['reserve']>, { status: 'reserved' }>
      | undefined;
    f.budget.reserve = vi.fn((request) => {
      const result = reserve(request);
      if (result.status === 'reserved') issued = result;
      return result;
    });
    let complete: ((value: ReturnType<typeof f.response>) => void) | undefined;
    f.deps.invoke!.invoke = vi.fn(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    const pending = observer.observeDotSemanticJudgment(f.input, f.deps);
    const originalHandle = issued!.handle;
    const foreignHandle = Object.freeze({});
    f.holds.set(foreignHandle, {
      owner: { ...f.owner, accounting_id: 'foreign-parent' },
      max: 50,
      state: 'reserved',
    });
    issued!.handle = foreignHandle;
    issued!.token_allowance = 999_999;
    complete!(f.response());
    expect(await pending).toMatchObject([{ status: 'observed', budget_status: 'settled' }]);
    expect(vi.mocked(f.budget.settle).mock.calls[0][0]).toBe(originalHandle);
    expect(f.holds.get(originalHandle)?.state).toBe('settled');
    expect(f.holds.get(foreignHandle)?.state).toBe('reserved');
    expect(vi.mocked(f.deps.persist!).mock.calls[0][0].parentTokenAllowance).toBe(200);
    expect(f.spent()).toBe(170);
    expect(f.budget.holdUnknown).not.toHaveBeenCalled();
  });

  it.each([
    { parentMs: 60_000, firstMs: 10_000, limit: 15_000 },
    { parentMs: 12_000, firstMs: 7_000, limit: 12_000 },
  ])(
    'shares one deadline across multiple proposals, bounded by the parent: %j',
    async ({ parentMs, firstMs, limit }) => {
      const f = fixture();
      const started = f.clock.time;
      f.input.parent.deadline_ms = started + parentMs;
      f.input.proposals = [
        structuredClone(f.input.proposals[0]),
        structuredClone(f.input.proposals[0]),
      ];
      let calls = 0;
      f.deps.invoke!.invoke = vi.fn((request) => {
        expect(request.deadlineMs).toBe(started + limit);
        if (++calls === 1) {
          f.clock.advance(firstMs);
          return Promise.resolve(f.response());
        }
        return new Promise(() => undefined);
      });
      const pending = observer.observeDotSemanticJudgment(f.input, f.deps);
      await flush();
      expect(f.deps.invoke!.invoke).toHaveBeenCalledTimes(2);
      f.clock.advance(limit - firstMs);
      expect(await pending).toMatchObject([
        { status: 'observed' },
        { status: 'pending_stop', budget_status: 'held_unknown', stop_confirmed: false },
      ]);
      expect(f.deps.persist).toHaveBeenCalledTimes(1);
      expect(f.spent()).toBe(170);
      expect(f.clock.pending).toBe(0);
    }
  );

  it('settles late usage in the original parent billing day after UTC rollover without borrowing a new parent', async () => {
    const f = fixture();
    let complete: ((value: ReturnType<typeof f.response>) => void) | undefined;
    f.deps.invoke!.invoke = vi.fn(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    const pending = observer.observeDotSemanticJudgment(f.input, f.deps);
    f.clock.advance(15_000);
    await pending;
    f.clock.advance(86_400_000);
    complete!(f.response());
    await flush();
    expect(f.spent()).toBe(170);
    expect(
      runtime.dotTokensUsedToday(f.owner.dot_id, {
        rootDir: fixtureRoot,
        now: () => new Date(f.clock.time),
      })
    ).toBe(0);
    expect(vi.mocked(f.budget.settle).mock.calls[0][1]).toEqual(f.owner);
    const rows = json
      .readJsonLines<{ dot_id: string; accounting_id: string; day: string }>(
        path.join(fixtureRoot, runtime.DOT_TOKEN_USAGE_PATH)
      )
      .filter((row) => row.dot_id === f.owner.dot_id);
    expect(
      rows.every((row) => row.day === '2026-10-31' && row.accounting_id === f.owner.accounting_id)
    ).toBe(true);
    expect(f.deps.persist).not.toHaveBeenCalled();
  });

  it('handles late rejection without unhandled promises or releasing unknown usage', async () => {
    const f = fixture();
    let reject: ((error: Error) => void) | undefined;
    f.deps.invoke!.invoke = vi.fn(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        })
    );
    const pending = observer.observeDotSemanticJudgment(f.input, f.deps);
    f.clock.advance(15_000);
    await pending;
    reject!(new Error('Late rejection'));
    await flush();
    expect(f.budget.holdUnknown).toHaveBeenCalledTimes(1);
    expect(f.budget.settle).not.toHaveBeenCalled();
    expect(f.deps.persist).not.toHaveBeenCalled();
    expect([...f.holds.values()][0].state).toBe('unknown');
  });

  it('does not release unknown usage on cancellation acknowledgement alone', async () => {
    const f = fixture();
    const parent = new AbortController();
    f.input.signal = parent.signal;
    f.deps.invoke!.invoke = vi.fn(
      (request) =>
        new Promise((_resolve, reject) =>
          request.signal.addEventListener(
            'abort',
            () => reject(new Error('Stopped, usage unknown')),
            { once: true }
          )
        )
    );
    const pending = observer.observeDotSemanticJudgment(f.input, f.deps);
    parent.abort();
    const result = await pending;
    expect(result).toMatchObject([{ budget_status: 'held_unknown', additional_model_calls: 1 }]);
    expect(f.budget.settle).not.toHaveBeenCalled();
    expect(f.deps.persist).not.toHaveBeenCalled();
    expect(f.clock.pending).toBe(0);
  });

  it('checks pause before admission and accounts work already invoked without adopting after pause', async () => {
    const f = fixture();
    f.pause();
    expect(await observer.observeDotSemanticJudgment(f.input, f.deps)).toMatchObject([
      { reason: 'evaluation_not_active' },
    ]);
    expect(f.budget.reserve).not.toHaveBeenCalled();
    const second = fixture();
    second.deps.invoke!.invoke = vi.fn(async () => {
      second.pause();
      return second.response();
    });
    expect(await observer.observeDotSemanticJudgment(second.input, second.deps)).toMatchObject([
      { reason: 'evaluation_not_active', budget_status: 'settled' },
    ]);
    expect(second.spent()).toBe(170);
    expect(second.deps.persist).not.toHaveBeenCalled();
  });

  it.each(['day', 'accounting', 'scope'] as const)(
    'rejects stale or mismatched current parent %s before any prepare or reserve',
    async (variant) => {
      const f = fixture();
      let result;
      if (variant === 'day') {
        f.input.parent.day = '2026-10-30';
        result = await observer.observeDotSemanticJudgment(f.input, f.deps);
      } else
        result = await accounting.withUsageAttribution(
          {
            actor_id: `dot:${f.owner.dot_id}`,
            accounting_id: variant === 'accounting' ? 'foreign-account' : f.owner.accounting_id,
            scope:
              variant === 'scope'
                ? { ...f.input.parent.scope, tenant_slug: 'other-tenant' }
                : f.input.parent.scope,
          },
          () => observer.observeDotSemanticJudgment(f.input, f.deps)
        );
      expect(result).toMatchObject([{ additional_model_calls: 0 }]);
      expect(f.deps.prepare).not.toHaveBeenCalled();
      expect(f.budget.reserve).not.toHaveBeenCalled();
      expect(f.deps.invoke!.invoke).not.toHaveBeenCalled();
    }
  );

  it('does not settle or release a foreign owner handle returned by a broken issuer', async () => {
    const f = fixture();
    const reserve = f.budget.reserve;
    f.budget.reserve = vi.fn((request) => {
      const result = reserve(request);
      return result.status === 'reserved'
        ? { ...result, owner: { ...result.owner, accounting_id: 'foreign-owner' } }
        : result;
    });
    expect(await observer.observeDotSemanticJudgment(f.input, f.deps)).toMatchObject([
      { reason: 'reservation_owner_mismatch', budget_status: 'foreign_reservation' },
    ]);
    expect(f.deps.invoke!.invoke).not.toHaveBeenCalled();
    expect(f.budget.holdUnknown).not.toHaveBeenCalled();
    expect(f.budget.settle).not.toHaveBeenCalled();
  });

  it('requires one-shot handle ownership and idempotent identical final settlement in the shared fixture port', () => {
    const f = fixture();
    f.inOwner(f.owner, () => {
      const reserved = f.budget.reserve({
        parent: f.owner,
        reservation_key: 'manual',
        max_tokens: 200,
      });
      if (reserved.status !== 'reserved') throw new Error('No test reservation');
      const usage: DotSemanticKnownUsage = {
        calls: 1,
        input_tokens: 10,
        output_tokens: 10,
        elapsed_ms: 1,
        usage_status: 'reported',
      };
      expect(() => f.budget.settle({}, f.owner, usage)).toThrow(/Foreign/);
      expect(() =>
        f.budget.settle(reserved.handle, { ...f.owner, accounting_id: 'foreign' }, usage)
      ).toThrow(/Foreign/);
      f.budget.settle(reserved.handle, f.owner, usage);
      f.budget.settle(reserved.handle, f.owner, usage);
      expect(f.spent()).toBe(120);
      expect(() =>
        f.budget.settle(reserved.handle, f.owner, { ...usage, output_tokens: 11 })
      ).toThrow(/Changed/);
      expect(() => f.budget.holdUnknown(reserved.handle, f.owner)).toThrow(/Final/);
    });
  });

  it('contains preparation, reservation and settlement failures without inventing charges or receipts', async () => {
    const f = fixture();
    f.deps.prepare = vi.fn(() => {
      throw new Error('Bad preparation');
    });
    expect(await observer.observeDotSemanticJudgment(f.input, f.deps)).toMatchObject([
      { reason: 'preparation_failed' },
    ]);
    expect(f.budget.reserve).not.toHaveBeenCalled();
    const second = fixture();
    second.budget.reserve = vi.fn(() => {
      throw new Error('Reserve unavailable');
    });
    expect(await observer.observeDotSemanticJudgment(second.input, second.deps)).toMatchObject([
      { reason: 'reservation_failed' },
    ]);
    expect(second.deps.invoke!.invoke).not.toHaveBeenCalled();
    const third = fixture();
    third.budget.settle = vi.fn(() => {
      throw new Error('Settlement unavailable');
    });
    expect(await observer.observeDotSemanticJudgment(third.input, third.deps)).toMatchObject([
      { reason: 'usage_not_settled', budget_status: 'settlement_failed' },
    ]);
    expect(third.deps.persist).not.toHaveBeenCalled();
    expect([...third.holds.values()][0].state).toBe('reserved');
  });

  it.each(['reserve', 'holdUnknown', 'settle'] as const)(
    'rejects an asynchronous %s result and catches its rejection without awaiting it',
    async (operation) => {
      const f = fixture();
      if (operation === 'reserve')
        f.budget.reserve = vi.fn(
          () =>
            Promise.reject(new Error('Async reserve')) as unknown as ReturnType<
              DotSemanticSharedBudgetPort['reserve']
            >
        );
      if (operation === 'holdUnknown') {
        f.deps.invoke!.invoke = vi.fn(async () => {
          throw new Error('Usage unknown');
        });
        f.budget.holdUnknown = vi.fn(
          () =>
            Promise.reject(new Error('Async hold')) as unknown as ReturnType<
              DotSemanticSharedBudgetPort['holdUnknown']
            >
        );
      }
      if (operation === 'settle')
        f.budget.settle = vi.fn(
          () =>
            Promise.reject(new Error('Async settlement')) as unknown as ReturnType<
              DotSemanticSharedBudgetPort['settle']
            >
        );
      const result = await observer.observeDotSemanticJudgment(f.input, f.deps);
      await flush();
      expect(result).toMatchObject([{ status: 'unavailable', budget_status: 'settlement_failed' }]);
      expect(f.deps.persist).not.toHaveBeenCalled();
      expect(f.spent()).toBe(100);
      if (operation === 'reserve') expect(f.deps.invoke!.invoke).not.toHaveBeenCalled();
      else expect([...f.holds.values()][0].state).toBe('reserved');
    }
  );
});
