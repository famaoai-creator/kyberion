import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { DecisionRecord } from '../decision-ledger/model.js';
import type { ScopeContext } from '../scope-context-validation.js';
import type { JudgmentEvidenceRequest, JudgmentEvidenceDeps } from './judgment-evidence.js';
import type { SemanticJudgmentResult } from './semantic-judgment.js';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtureRoot = path.join(
  sourceRoot,
  `active/shared/tmp/vitest-judgment-evidence-${process.pid}`
);
let bootstrapIo: typeof import('../secure-io.js');
let io: typeof import('../secure-io.js');
let store: typeof import('../workforce/artifact-store.js');
let evidence: typeof import('./judgment-evidence.js');
let semantic: typeof import('./semantic-judgment.js');
let precedents: typeof import('./judgment-precedents.js');
let validation: typeof import('./judgment-validation.js');
let json: typeof import('../foundation/json.js');

const scope: ScopeContext = {
  tier: 'confidential',
  tenant_slug: 'synthetic-latency',
  organization_id: 'fixture-org',
  project_id: 'fixture-project',
};
const config = { provider: 'fixture-provider', model: 'fixture-model', maxOutputTokens: 500 };
const baseTime = Date.parse('2026-10-31T00:00:00.000Z');
let sequence = 0;
function decision(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: 'D-0001',
    case_id: 'case-a',
    item: 'service-latency',
    key: 'performance.goal',
    level: 'product-fixed',
    state: 'decided',
    value: { users: 100, p95: 500 },
    basis: [{ ref: 'synthetic-goal', version: '1' }],
    decided_by: { kind: 'human', id: 'user:fixture-owner', role: 'owner' },
    decided_at: '2026-10-31T00:00:00.000Z',
    origin: 'console',
    status: 'active',
    ...overrides,
  };
}
function snapshot(record = decision()) {
  const result = precedents.createJudgmentPrecedentSnapshot(
    { scope, selected_case_ids: ['case-a'], allowed_case_ids: ['case-a'] },
    {
      resolveCaseBinding: () => ({ case_id: 'case-a', scope }),
      readLedger: () => [record],
      resolveGoals: (source) => [
        {
          case_id: source.case_id,
          decision_id: source.decision_id,
          decision_version_hash: source.decision_version_hash,
          constraints: {
            kind: 'latency_goal_v1',
            goal_key: 'latency',
            service_key: 'fixture-service',
            load_profile_hash: 'a'.repeat(64),
            target_users: 100,
            max_p95_ms: 500,
            max_incremental_monthly_cost: 0,
            currency: 'JPY',
            permitted_change: 'isolated_fixture_only',
          },
        },
      ],
    }
  );
  if (result.status !== 'ready') throw new Error('Invalid synthetic snapshot');
  return result.snapshot;
}
async function fixture() {
  const initial = snapshot();
  const modelInput = validation.buildJudgmentModelInput(
    initial,
    {
      proposal_key: 'repair-fixture',
      service_key: 'fixture-service',
      load_profile_hash: 'a'.repeat(64),
      change_scope: 'isolated_fixture_only',
      requested_goal: { target_users: 100, max_p95_ms: 500 },
      incremental_monthly_cost: 0,
      currency: 'JPY',
    },
    [{ evidence_key: 'sample-1', text: '65 users, p95 1800ms (synthetic)' }]
  );
  const binding = {
    schema_version: '1' as const,
    work_ref: `incident-${++sequence}`,
    work_revision: '1',
    trigger_key: 'event-1',
    scope_hash: initial.scope_hash,
    ...validation.judgmentModelInputHashes(modelInput),
    precedent_snapshot_hash: initial.snapshot_hash,
    policy_version: 'policy-1',
    rubric_version: 'rubric-1',
    evaluator_version: 'evaluator-1',
    model_config_hash: semantic.semanticJudgmentModelConfigHash(config),
  };
  const context = {
    binding,
    scope,
    modelInput,
    snapshot: initial,
    requiredGoalKeys: ['latency'],
    knownProposalKeys: ['repair-fixture'],
  };
  const clock = { now: baseTime };
  let current = {
    expectedBinding: binding,
    currentSnapshot: { status: 'ready' as const, snapshot: initial },
  };
  const deps: JudgmentEvidenceDeps = {
    now: () => clock.now,
    readCurrentContext: () => current,
    createTrace: () => ({
      traceId: 'deterministic-trace',
      rootSpan: {
        spanId: 'deterministic-span',
        name: 'fixture',
        startTime: new Date(clock.now).toISOString(),
        status: 'ok',
        events: [],
        artifacts: [],
        knowledgeRefs: [],
        children: [],
      },
      metadata: {
        startedAt: new Date(clock.now).toISOString(),
        customerId: 'foreign-env-customer',
        tenantSlug: 'foreign-env-tenant',
      },
    }),
  };
  const request: JudgmentEvidenceRequest = {
    context,
    effectRef: `effect-${sequence}`,
    modelConfig: config,
  };
  const assess = async (): Promise<SemanticJudgmentResult> =>
    semantic.assessSemanticJudgment(
      {
        ...context,
        mode: 'offline_fixture',
        parentDeadlineMs: clock.now + 15_000,
        parentTokenAllowance: 1000,
        maxOutputTokens: 500,
      },
      {
        now: () => clock.now,
        schedule: () => () => undefined,
        readCurrentContext: () => current,
        port: {
          mode: 'offline_fixture',
          provider: config.provider,
          model: config.model,
          invoke: async () => ({
            text: JSON.stringify({
              disposition: 'apply_precedent',
              precedent_keys: initial.evidence_refs.map((ref) => ref.source_key),
              rationale: '既決の目標と費用制約を維持。',
              applicability: ['合成fixture内の局所修正'],
            }),
            usage: { input_tokens: 40, output_tokens: 30 },
          }),
        },
      }
    );
  return {
    request,
    deps,
    clock,
    assess,
    result: await assess(),
    changeCurrent: (record: DecisionRecord) => {
      current = {
        expectedBinding: binding,
        currentSnapshot: { status: 'ready', snapshot: snapshot(record) },
      };
    },
  };
}
const write = (fixture: Awaited<ReturnType<typeof fixture>>) =>
  evidence.saveJudgmentEvidence(
    { ...fixture.request, result: fixture.result, parentTokenAllowance: 1000 },
    fixture.deps
  );
const parentFor = (f: Awaited<ReturnType<typeof fixture>>) =>
  evidence.judgmentEvidenceParent({
    scope: f.request.context.scope,
    binding: f.request.context.binding,
    effectRef: f.request.effectRef,
  });
const resolve = (f: Awaited<ReturnType<typeof fixture>>, parent = parentFor(f)) =>
  evidence.resolveLatestJudgmentEvidence({ ...f.request, parent }, f.deps);
const audit = (f: Awaited<ReturnType<typeof fixture>>, address: unknown) =>
  evidence.readHistoricalJudgmentEvidence({
    scope: f.request.context.scope,
    binding: f.request.context.binding,
    effectRef: f.request.effectRef,
    address,
  });
function artifactBytes(): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (directory: string): void => {
    if (!io.safeExistsSync(directory)) return;
    for (const name of io.safeReaddir(directory)) {
      const file = path.join(directory, name);
      if (io.safeLstat(file).isDirectory()) walk(file);
      else files[file] = io.safeReadFile(file, { encoding: 'utf8' }) as string;
    }
  };
  walk(path.join(fixtureRoot, 'active'));
  return files;
}

describe('judgment evidence with actual isolated scoped artifact attempts', () => {
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
    io = await import('../secure-io.js');
    store = await import('../workforce/artifact-store.js');
    const { saveProjectRecord } = await import('../project/project-registry.js');
    saveProjectRecord({
      project_id: 'fixture-project',
      name: 'Fixture',
      summary: 'Synthetic receipt test',
      status: 'active',
      tier: 'confidential',
      tenant_slug: 'synthetic-latency',
      organization_id: 'fixture-org',
    } as Parameters<typeof saveProjectRecord>[0]);
    evidence = await import('./judgment-evidence.js');
    semantic = await import('./semantic-judgment.js');
    precedents = await import('./judgment-precedents.js');
    validation = await import('./judgment-validation.js');
    json = await import('../foundation/json.js');
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => {
    vi.unstubAllEnvs();
    bootstrapIo?.safeRmSync(fixtureRoot, { recursive: true, force: true });
    vi.resetModules();
  });

  it('stores reconstructable evidence and a required scoped minimal trace, then reuses it', async () => {
    const f = await fixture();
    const saved = write(f);
    expect(saved.status).toBe('persisted');
    if (saved.status !== 'persisted') throw new Error(saved.detail);
    const envelope = JSON.parse(
      io.safeReadFile(path.join(fixtureRoot, saved.reference.artifact_ref), {
        encoding: 'utf8',
      }) as string
    );
    expect(envelope.content).toMatchObject({
      mode: 'offline_fixture',
      scope,
      model_config: config,
      parent_token_allowance: 1000,
      assessment: f.result.assessment,
      usage: f.result.usage,
    });
    expect(envelope.content.model_input).toEqual(f.request.context.modelInput);
    expect(envelope.content.snapshot).toEqual(f.request.context.snapshot);
    const traceText = io.safeReadFile(path.join(fixtureRoot, saved.reference.trace.artifact_ref), {
      encoding: 'utf8',
    }) as string;
    expect(traceText).toContain('deterministic-trace');
    expect(traceText).not.toContain('foreign-env');
    expect(traceText).not.toContain('65 users');
    expect(traceText).not.toContain('既決');
    const reused = evidence.reuseJudgmentEvidence(
      { ...f.request, address: saved.reference.address },
      f.deps
    );
    expect(reused).toMatchObject({
      status: 'persisted',
      adopted_existing: true,
      reference: saved.reference,
    });
    const index = store.readScopedArtifactIndex(
      { tenant: scope.tenant_slug, organization: scope.organization_id, project: scope.project_id },
      'confidential'
    );
    expect(index.filter((entry) => entry.path === saved.reference.artifact_ref)).toHaveLength(1);
    expect(index.filter((entry) => entry.path === saved.reference.trace.artifact_ref)).toHaveLength(
      1
    );
    expect(JSON.stringify(index)).not.toContain('65 users');
  });

  it('refuses wrong scope, reference hashes, arbitrary path fields, effect and current sources', async () => {
    const f = await fixture();
    const saved = write(f);
    if (saved.status !== 'persisted') throw new Error(saved.detail);
    const reuse = (address = saved.reference.address) =>
      evidence.reuseJudgmentEvidence({ ...f.request, address }, f.deps);
    expect(reuse({ ...saved.reference.address, content_hash: 'b'.repeat(64) })).toMatchObject({
      status: 'unavailable',
    });
    expect(reuse({ ...saved.reference.address, evaluation_key: 'b'.repeat(64) })).toMatchObject({
      status: 'unavailable',
    });
    expect(
      reuse({
        ...saved.reference.address,
        path: 'knowledge/confidential/other/file',
      } as typeof saved.reference.address)
    ).toMatchObject({ status: 'unavailable' });
    expect(
      evidence.reuseJudgmentEvidence(
        { ...f.request, effectRef: 'other-effect', address: saved.reference.address },
        f.deps
      )
    ).toMatchObject({ status: 'unavailable' });
    expect(
      evidence.reuseJudgmentEvidence(
        {
          ...f.request,
          context: { ...f.request.context, scope: { ...scope, tenant_slug: 'other-tenant' } },
          address: saved.reference.address,
        },
        f.deps
      )
    ).toMatchObject({ status: 'unavailable' });
    f.changeCurrent(decision({ value: { users: 65, p95: 1800 } }));
    expect(reuse()).toMatchObject({ status: 'unavailable', reason: 'stale_precedent' });
  });

  it('refuses invalid assessment identity, config, usage and unavailable outcomes', async () => {
    const f = await fixture();
    expect(
      evidence.saveJudgmentEvidence(
        {
          ...f.request,
          result: {
            assessment: { status: 'unavailable', reason: 'provider_error', detail: 'failure' },
            usage: f.result.usage,
          },
          parentTokenAllowance: 1000,
        },
        f.deps
      )
    ).toMatchObject({ status: 'unavailable' });
    if (f.result.assessment.status !== 'evaluated') throw new Error('Expected evaluated fixture');
    for (const result of [
      { ...f.result, assessment: { ...f.result.assessment, model: 'other-model' } },
      { ...f.result, usage: { ...f.result.usage, output_tokens: 501 } },
      { ...f.result, usage: { ...f.result.usage, input_tokens: 1000 } },
      { ...f.result, usage: { ...f.result.usage, input_tokens: null } },
      { ...f.result, usage: { ...f.result.usage, elapsed_ms: 15_000.001 } },
    ])
      expect(
        evidence.saveJudgmentEvidence({ ...f.request, result, parentTokenAllowance: 1000 }, f.deps)
      ).toMatchObject({ status: 'unavailable' });
    expect(
      evidence.saveJudgmentEvidence(
        {
          ...f.request,
          result: f.result,
          modelConfig: { ...config, model: 'other-model' },
          parentTokenAllowance: 1000,
        },
        f.deps
      )
    ).toMatchObject({ status: 'unavailable' });
  });

  it('rejects candidate allowance below the configured output cap even when actual usage fits', async () => {
    const f = await fixture();
    expect(
      evidence.saveJudgmentEvidence(
        { ...f.request, result: f.result, parentTokenAllowance: 100 },
        f.deps
      )
    ).toMatchObject({ status: 'unavailable' });
  });

  it('rejects an occupied impossible invocation even with a correct recomputed payload hash', async () => {
    const f = await fixture();
    const saved = write(f);
    if (saved.status !== 'persisted') throw new Error(saved.detail);
    const file = path.join(fixtureRoot, saved.reference.artifact_ref);
    const envelope = JSON.parse(io.safeReadFile(file, { encoding: 'utf8' }) as string);
    envelope.content.parent_token_allowance = 100; // usage=70 fits; configured cap=500 cannot start.
    envelope.content_hash = createHash('sha256')
      .update(JSON.stringify(envelope.content), 'utf8')
      .digest('hex');
    io.safeWriteFile(file, JSON.stringify(envelope, null, 2));
    expect(
      evidence.reuseJudgmentEvidence(
        {
          ...f.request,
          address: { ...saved.reference.address, content_hash: envelope.content_hash },
        },
        f.deps
      )
    ).toMatchObject({ status: 'unavailable' });
    expect(write(f)).toMatchObject({ status: 'unavailable' });
  });

  it('allocates a fresh immutable attempt after expiry while keeping parent work and effect', async () => {
    const f = await fixture();
    const first = write(f);
    if (first.status !== 'persisted') throw new Error(first.detail);
    const original = io.safeReadFile(path.join(fixtureRoot, first.reference.artifact_ref), {
      encoding: 'utf8',
    });
    f.clock.now += 5 * 60_000;
    expect(
      evidence.reuseJudgmentEvidence({ ...f.request, address: first.reference.address }, f.deps)
    ).toMatchObject({ status: 'unavailable' });
    f.result = await f.assess();
    const next = write(f);
    expect(next).toMatchObject({
      status: 'persisted',
      adopted_existing: false,
      reference: {
        address: {
          attempt: 2,
          evaluation_key: first.reference.address.evaluation_key,
          effect_key: first.reference.address.effect_key,
        },
      },
    });
    expect(
      io.safeReadFile(path.join(fixtureRoot, first.reference.artifact_ref), { encoding: 'utf8' })
    ).toEqual(original);
    f.clock.now = baseTime + 1000;
    expect(
      evidence.reuseJudgmentEvidence({ ...f.request, address: first.reference.address }, f.deps)
    ).toMatchObject({ status: 'unavailable' });
    if (next.status !== 'persisted') throw new Error(next.detail);
    expect(
      evidence.reuseJudgmentEvidence({ ...f.request, address: next.reference.address }, f.deps)
    ).toMatchObject({ status: 'unavailable' });
  });

  it('converges actual create-only collisions to a different valid winner verdict', async () => {
    const f = await fixture();
    if (f.result.assessment.status !== 'evaluated') throw new Error('Expected evaluated fixture');
    const winner: SemanticJudgmentResult = {
      ...f.result,
      assessment: {
        ...f.result.assessment,
        verdict: {
          disposition: 'reframe',
          violated_goal_keys: ['latency'],
          rationale: '追加調査が必要。',
          revised_question: '元目標を保って原因を調べるには？',
          evidence_needed: [],
        },
      },
    };
    const original = io.safeWriteFile;
    let collided = false;
    vi.spyOn(io, 'safeWriteFile').mockImplementation((file, data, options) => {
      if (!collided && String(file).includes('/evidence/semantic-judgment/')) {
        collided = true;
        expect(
          evidence.saveJudgmentEvidence(
            { ...f.request, result: winner, parentTokenAllowance: 1000 },
            f.deps
          )
        ).toMatchObject({ status: 'persisted' });
      }
      return original(file, data, options);
    });
    expect(write(f)).toMatchObject({
      status: 'persisted',
      adopted_existing: true,
      assessment: { verdict: { disposition: 'reframe' } },
    });
    expect(collided).toBe(true);
  });

  it.each(['evidence', 'log'])(
    'repairs %s payload-before-index orphans without rewriting the winner',
    async (artifactClass) => {
      const f = await fixture();
      const append = json.appendJsonLine;
      let failed = false;
      vi.spyOn(json, 'appendJsonLine').mockImplementation((file, value) => {
        if (!failed && (value as { artifact_class?: string }).artifact_class === artifactClass) {
          failed = true;
          throw new Error('simulated interruption before index');
        }
        return append(file, value);
      });
      expect(write(f)).toMatchObject({ status: 'unavailable' });
      expect(failed).toBe(true);
      vi.restoreAllMocks();
      const saved = write(f);
      expect(saved).toMatchObject({ status: 'persisted', adopted_existing: true });
      if (saved.status !== 'persisted') throw new Error(saved.detail);
      const again = write(f);
      expect(again).toMatchObject({ status: 'persisted', reference: saved.reference });
    }
  );

  it('does not report persistence when required trace storage fails', async () => {
    const f = await fixture();
    const original = io.safeWriteFile;
    vi.spyOn(io, 'safeWriteFile').mockImplementation((file, data, options) => {
      if (String(file).includes('/log/semantic-judgment-trace/'))
        throw new Error('trace storage unavailable');
      return original(file, data, options);
    });
    expect(write(f)).toMatchObject({ status: 'unavailable' });
    vi.restoreAllMocks();
    expect(write(f)).toMatchObject({ status: 'persisted', adopted_existing: true });
  });

  it.each(['evidence/semantic-judgment/', 'log/semantic-judgment-trace/'])(
    'rechecks current sources after %s writes',
    async (boundary) => {
      const f = await fixture();
      const original = io.safeWriteFile;
      vi.spyOn(io, 'safeWriteFile').mockImplementation((file, data, options) => {
        const result = original(file, data, options);
        if (String(file).includes(`/${boundary}`))
          f.changeCurrent(decision({ basis: [{ ref: 'updated', version: '2' }] }));
        return result;
      });
      expect(write(f)).toMatchObject({ status: 'unavailable', reason: 'stale_precedent' });
    }
  );

  it('rechecks expiry after the final fresh context read', async () => {
    const f = await fixture();
    const saved = write(f);
    if (saved.status !== 'persisted') throw new Error(saved.detail);
    const read = f.deps.readCurrentContext;
    let reads = 0;
    f.deps.readCurrentContext = () => {
      const result = read();
      // preflight + before trace + after trace: expire at the last refresh boundary.
      if (++reads === 3) f.clock.now += 5 * 60_000;
      return result;
    };
    expect(
      evidence.reuseJudgmentEvidence({ ...f.request, address: saved.reference.address }, f.deps)
    ).toMatchObject({ status: 'unavailable' });
    expect(reads).toBe(3);
  });

  it('keeps the effect key stable when trigger, work revision or model config changes', async () => {
    const f = await fixture();
    const first = write(f);
    if (first.status !== 'persisted') throw new Error(first.detail);
    const binding = f.request.context.binding as {
      trigger_key: string;
      work_revision: string;
      model_config_hash: string;
    };
    binding.trigger_key = 'new-trigger';
    binding.work_revision = '2';
    f.request.modelConfig = { ...config, model: 'new-model' };
    binding.model_config_hash = semantic.semanticJudgmentModelConfigHash(f.request.modelConfig);
    if (f.result.assessment.status !== 'evaluated') throw new Error('Expected evaluated fixture');
    // Fixture current context shares this server binding. Model metadata must change too.
    f.result.assessment = {
      ...f.result.assessment,
      binding: f.request.context.binding as typeof f.result.assessment.binding,
      model: 'new-model',
    };
    const second = write(f);
    expect(second).toMatchObject({
      status: 'persisted',
      reference: { address: { effect_key: first.reference.address.effect_key } },
    });
    if (second.status !== 'persisted') throw new Error(second.detail);
    expect(second.reference.address.evaluation_key).not.toBe(
      first.reference.address.evaluation_key
    );
  });

  it('rejects occupied receipt corruption and latest payload deletion instead of issuing a new attempt', async () => {
    const f = await fixture();
    const saved = write(f);
    if (saved.status !== 'persisted') throw new Error(saved.detail);
    const target = path.join(fixtureRoot, saved.reference.artifact_ref);
    const bytes = io.safeReadFile(target, { encoding: 'utf8' }) as string;
    io.safeWriteFile(target, bytes.replace('合成fixture内の局所修正', '改ざん'));
    expect(
      evidence.reuseJudgmentEvidence({ ...f.request, address: saved.reference.address }, f.deps)
    ).toMatchObject({ status: 'unavailable' });
    io.safeRmSync(target);
    f.clock.now += 5 * 60_000;
    f.result = await f.assess();
    expect(write(f)).toMatchObject({ status: 'unavailable' });
  });

  it('strictly parses receipt selectors without accepting lossy properties or coercing ordinals', async () => {
    const f = await fixture();
    const saved = write(f);
    if (saved.status !== 'persisted') throw new Error(saved.detail);
    const address = saved.reference.address;
    expect(evidence.parseJudgmentReceiptAddress(address)).toEqual(address);
    expect(evidence.parseJudgmentReceiptAddress(address)).not.toBe(address);
    expect(
      evidence.parseJudgmentReceiptAddress({
        content_hash: address.content_hash,
        attempt: address.attempt,
        effect_key: address.effect_key,
        evaluation_key: address.evaluation_key,
      })
    ).toEqual(address);
    const accessor = { ...address };
    const getter = vi.fn(() => address.attempt);
    Object.defineProperty(accessor, 'attempt', { get: getter, enumerable: true });
    const hidden = Object.defineProperty({ ...address }, 'hidden', { value: 1 });
    const symbolic = Object.assign({ ...address }, { [Symbol('hidden')]: 1 });
    const badProto = JSON.parse(
      JSON.stringify(address).replace(/}$/, ',"__proto__":{"hidden":1}}')
    );
    for (const input of [
      null,
      [],
      { ...address, path: '/arbitrary/path' },
      { ...address, optional: undefined },
      accessor,
      hidden,
      symbolic,
      badProto,
      Object.assign(Object.create({ inherited: true }), address),
      ...[0, -1, 129, 1.5, NaN, Infinity, '1', undefined].map((attempt) => ({
        ...address,
        attempt,
      })),
      { ...address, effect_key: 'b'.repeat(63) },
      { ...address, content_hash: 'B'.repeat(64) },
    ])
      expect(() => evidence.parseJudgmentReceiptAddress(input)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(
      evidence.reuseJudgmentEvidence({ ...f.request, address: accessor }, f.deps)
    ).toMatchObject({ status: 'unavailable' });
  });

  it('derives one frozen parent from the complete canonical server binding', async () => {
    const f = await fixture();
    const saved = write(f);
    if (saved.status !== 'persisted') throw new Error(saved.detail);
    const original = parentFor(f);
    expect(original).toEqual({
      evaluation_key: saved.reference.address.evaluation_key,
      effect_key: saved.reference.address.effect_key,
    });
    expect(Object.isFrozen(original)).toBe(true);
    const binding = f.request.context.binding as Record<string, string>;
    const fields = Object.keys(binding).filter(
      (field) => !['schema_version', 'scope_hash'].includes(field)
    );
    for (const field of fields) {
      const changed = {
        ...binding,
        [field]: field.endsWith('_hash') ? 'b'.repeat(64) : `${binding[field]}-changed`,
      };
      const parent = evidence.judgmentEvidenceParent({
        scope,
        binding: changed,
        effectRef: f.request.effectRef,
      });
      expect(parent.evaluation_key, field).not.toBe(original.evaluation_key);
      expect(parent.effect_key === original.effect_key, field).toBe(field !== 'work_ref');
      expect(resolve(f, parent), field).toMatchObject({ status: 'unavailable' });
    }
    expect(() =>
      evidence.judgmentEvidenceParent({
        scope,
        binding: { ...binding, schema_version: '2' },
        effectRef: f.request.effectRef,
      })
    ).toThrow();
    expect(() =>
      evidence.judgmentEvidenceParent({
        scope,
        binding: { ...binding, scope_hash: 'b'.repeat(64) },
        effectRef: f.request.effectRef,
      })
    ).toThrow();
    expect(() =>
      evidence.judgmentEvidenceParent({
        scope,
        binding: { ...binding, ignored: undefined },
        effectRef: f.request.effectRef,
      })
    ).toThrow();
    expect(() =>
      evidence.judgmentEvidenceParent({
        scope: { ...scope, extra: 'unknown' },
        binding,
        effectRef: f.request.effectRef,
      })
    ).toThrow();
    expect(() =>
      evidence.judgmentEvidenceParent({ scope, binding, effectRef: ' effect ' })
    ).toThrow();
    const otherScope = { ...scope, tenant_slug: 'other-tenant' };
    const other = evidence.judgmentEvidenceParent({
      scope: otherScope,
      binding: { ...binding, scope_hash: precedents.judgmentCanonicalHash(otherScope) },
      effectRef: f.request.effectRef,
    });
    expect(other.evaluation_key).not.toBe(original.evaluation_key);
    expect(other.effect_key).not.toBe(original.effect_key);
    expect(resolve(f, other)).toMatchObject({ status: 'unavailable' });
    expect(
      resolve(f, evidence.judgmentEvidenceParent({ scope, binding, effectRef: 'other-effect' }))
    ).toMatchObject({ status: 'unavailable' });
    expect(original).toEqual(parentFor(f));
  });

  it('rejects forged or lossy parents before artifact access', async () => {
    const f = await fixture();
    const parent = parentFor(f);
    const read = vi.spyOn(store, 'readScopedArtifactAttempt');
    const writeAttempt = vi.spyOn(store, 'writeScopedArtifactAttempt');
    const accessor = { ...parent };
    const getter = vi.fn(() => parent.effect_key);
    Object.defineProperty(accessor, 'effect_key', { get: getter, enumerable: true });
    for (const candidate of [
      accessor,
      Object.assign({ ...parent }, { [Symbol('hidden')]: true }),
      Object.defineProperty({ ...parent }, 'hidden', { value: 1 }),
      { ...parent, attempt: 1 },
      { ...parent, path: 'knowledge/confidential/other/file' },
      { ...parent, effect_key: 'b'.repeat(64) },
      { ...parent, evaluation_key: 'b'.repeat(64) },
    ])
      expect(resolve(f, candidate)).toMatchObject({ status: 'unavailable' });
    expect(getter).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(writeAttempt).not.toHaveBeenCalled();
  });

  it('resolves only the latest attempt without mutating the origin reference or allocating a receipt', async () => {
    const f = await fixture();
    const first = write(f);
    if (first.status !== 'persisted') throw new Error(first.detail);
    const origin = structuredClone(first.reference.address);
    const originJson = JSON.stringify(origin);
    const file = path.join(fixtureRoot, first.reference.artifact_ref);
    const bytes = io.safeReadFile(file, { encoding: 'utf8' });
    const parent = parentFor(f);
    const attemptWriter = vi.spyOn(store, 'writeScopedArtifactAttempt');
    expect(resolve(f, parent)).toMatchObject({ status: 'persisted', reference: first.reference });
    expect(attemptWriter.mock.calls.every(([input]) => input.artifact_class === 'log')).toBe(true);
    attemptWriter.mockClear();
    f.clock.now += 5 * 60_000;
    expect(resolve(f, parent)).toMatchObject({ status: 'unavailable' });
    expect(attemptWriter).not.toHaveBeenCalled();
    f.result = await f.assess();
    const second = write(f);
    if (second.status !== 'persisted') throw new Error(second.detail);
    expect(second.reference.address.attempt).toBe(2);
    attemptWriter.mockClear();
    expect(resolve(f, parent)).toMatchObject({ status: 'persisted', reference: second.reference });
    expect(attemptWriter.mock.calls.every(([input]) => input.artifact_class === 'log')).toBe(true);
    expect(evidence.reuseJudgmentEvidence({ ...f.request, address: origin }, f.deps)).toMatchObject(
      { status: 'unavailable' }
    );
    expect(JSON.stringify(origin)).toBe(originJson);
    expect(io.safeReadFile(file, { encoding: 'utf8' })).toBe(bytes);
    expect(parentFor(f)).toEqual(parent);
  });

  it.each(['trace-write', 'trace-index'] as const)(
    'may repair required %s evidence without changing receipt bytes',
    async (failure) => {
      const f = await fixture();
      let receiptPath = '';
      let receiptBytes = '';
      const originalWrite = io.safeWriteFile;
      const append = json.appendJsonLine;
      vi.spyOn(io, 'safeWriteFile').mockImplementation((file, data, options) => {
        if (
          String(file).includes('/evidence/semantic-judgment/') &&
          !String(file).includes('.tmp.')
        ) {
          receiptPath = String(file);
          receiptBytes = String(data);
        }
        if (failure === 'trace-write' && String(file).includes('/log/semantic-judgment-trace/'))
          throw new Error('Trace write interrupted');
        return originalWrite(file, data, options);
      });
      vi.spyOn(json, 'appendJsonLine').mockImplementation((file, entry) => {
        if (
          failure === 'trace-index' &&
          (entry as { artifact_class?: string }).artifact_class === 'log'
        )
          throw new Error('Trace registration interrupted');
        return append(file, entry);
      });
      expect(write(f)).toMatchObject({ status: 'unavailable' });
      expect(receiptPath).not.toBe('');
      vi.restoreAllMocks();
      const attempts = vi.spyOn(store, 'writeScopedArtifactAttempt');
      const resolved = resolve(f);
      expect(resolved).toMatchObject({
        status: 'persisted',
        reference: { address: { attempt: 1 } },
      });
      expect(attempts).toHaveBeenCalledOnce();
      expect(attempts.mock.calls[0][0].artifact_class).toBe('log');
      expect(io.safeReadFile(receiptPath, { encoding: 'utf8' })).toBe(receiptBytes);
    }
  );

  it.each([
    'missing',
    'corrupt',
    'expired',
    'current-source',
    'current-binding',
    'absent',
  ] as const)(
    'latest resolver fails closed for %s without allocating another receipt',
    async (condition) => {
      const f = await fixture();
      const parent = parentFor(f);
      if (condition !== 'absent') {
        const saved = write(f);
        if (saved.status !== 'persisted') throw new Error(saved.detail);
        const file = path.join(fixtureRoot, saved.reference.artifact_ref);
        if (condition === 'missing') io.safeRmSync(file);
        if (condition === 'corrupt') io.safeWriteFile(file, '{}');
        if (condition === 'expired') f.clock.now += 5 * 60_000;
        if (condition === 'current-source')
          f.changeCurrent(decision({ value: { users: 65, p95: 1800 } }));
        if (condition === 'current-binding') {
          const read = f.deps.readCurrentContext;
          f.deps.readCurrentContext = () => ({
            ...read(),
            expectedBinding: {
              ...(f.request.context.binding as Record<string, unknown>),
              policy_version: 'changed-policy',
            },
          });
        }
      }
      const attempts = vi.spyOn(store, 'writeScopedArtifactAttempt');
      expect(resolve(f, parent)).toMatchObject({ status: 'unavailable' });
      expect(attempts).not.toHaveBeenCalled();
    }
  );

  it('audits an expired original after a later attempt without freshness, authority or writes', async () => {
    const f = await fixture();
    const first = write(f);
    if (first.status !== 'persisted') throw new Error(first.detail);
    f.clock.now += 5 * 60_000;
    f.result = await f.assess();
    const second = write(f);
    if (second.status !== 'persisted') throw new Error(second.detail);
    expect(second.reference.address.attempt).toBe(2);
    expect(resolve(f)).toMatchObject({ reference: second.reference });
    expect(
      evidence.reuseJudgmentEvidence({ ...f.request, address: first.reference.address }, f.deps)
    ).toMatchObject({ status: 'unavailable' });
    const before = artifactBytes();
    const writes = vi.spyOn(store, 'writeScopedArtifactAttempt');
    const clock = vi.spyOn(f.deps, 'now');
    const current = vi.spyOn(f.deps, 'readCurrentContext');
    const result = audit(f, first.reference.address);
    expect(result).toEqual({
      status: 'historical_verified',
      address: first.reference.address,
      assessment: first.assessment,
      model_input: f.request.context.modelInput,
    });
    expect(Object.keys(result).sort()).toEqual(['address', 'assessment', 'model_input', 'status']);
    expect(Object.isFrozen(result)).toBe(true);
    if (result.status !== 'historical_verified') throw new Error(result.detail);
    expect(Object.isFrozen(result.model_input.proposal)).toBe(true);
    expect(Object.isFrozen(result.assessment.binding)).toBe(true);
    expect(result.address).not.toBe(first.reference.address);
    expect(writes).not.toHaveBeenCalled();
    expect(clock).not.toHaveBeenCalled();
    expect(current).not.toHaveBeenCalled();
    expect(artifactBytes()).toEqual(before);
  });

  it('rejects every changed binding axis and strict scope/effect/address selectors without writes', async () => {
    const f = await fixture();
    const saved = write(f);
    if (saved.status !== 'persisted') throw new Error(saved.detail);
    const input = {
      scope,
      binding: f.request.context.binding,
      effectRef: f.request.effectRef,
      address: saved.reference.address,
    };
    const before = artifactBytes();
    for (const field of Object.keys(input.binding)) {
      expect(
        evidence.readHistoricalJudgmentEvidence({
          ...input,
          binding: {
            ...input.binding,
            [field]: field.endsWith('_hash') ? 'f'.repeat(64) : 'changed',
          },
        })
      ).toMatchObject({ status: 'unavailable' });
    }
    for (const changed of [
      { scope: { ...scope, tenant_slug: 'other-tenant' } },
      { scope: { ...scope, project_id: 'other-project' } },
      { scope: { ...scope, extra: true } },
      { effectRef: 'other-effect' },
      { effectRef: ' padded ' },
      { address: { ...input.address, content_hash: 'f'.repeat(64) } },
      { address: { ...input.address, effect_key: 'f'.repeat(64) } },
      { address: { ...input.address, evaluation_key: 'f'.repeat(64) } },
      { address: { ...input.address, attempt: 0 } },
      { address: { ...input.address, attempt: 129 } },
      { address: { ...input.address, path: 'arbitrary/path' } },
    ])
      expect(evidence.readHistoricalJudgmentEvidence({ ...input, ...changed })).toMatchObject({
        status: 'unavailable',
      });
    expect(
      evidence.readHistoricalJudgmentEvidence(
        Object.defineProperty({ ...input }, 'extra', { value: true })
      )
    ).toMatchObject({ status: 'unavailable' });
    expect(
      evidence.readHistoricalJudgmentEvidence({ ...input, extra: true } as typeof input)
    ).toMatchObject({ status: 'unavailable' });
    expect(artifactBytes()).toEqual(before);
  });

  it.each(['origin-corrupt', 'later-corrupt', 'latest-missing'] as const)(
    'historical audit fails closed for %s even when selecting the original',
    async (condition) => {
      const f = await fixture();
      const first = write(f);
      if (first.status !== 'persisted') throw new Error(first.detail);
      f.clock.now += 5 * 60_000;
      f.result = await f.assess();
      const second = write(f);
      if (second.status !== 'persisted') throw new Error(second.detail);
      const target = path.join(
        fixtureRoot,
        condition === 'origin-corrupt'
          ? first.reference.artifact_ref
          : second.reference.artifact_ref
      );
      if (condition === 'latest-missing') io.safeRmSync(target);
      else io.safeWriteFile(target, '{}');
      const before = artifactBytes();
      expect(audit(f, first.reference.address)).toMatchObject({ status: 'unavailable' });
      expect(artifactBytes()).toEqual(before);
    }
  );

  it.each(['evidence-index', 'trace-write'] as const)(
    'audits immutable payload after failed %s without repairing registration or trace',
    async (failure) => {
      const f = await fixture();
      const append = json.appendJsonLine;
      const original = io.safeWriteFile;
      let address:
        | { evaluation_key: string; effect_key: string; attempt: number; content_hash: string }
        | undefined;
      vi.spyOn(io, 'safeWriteFile').mockImplementation((file, data, options) => {
        if (failure === 'trace-write' && String(file).includes('/log/semantic-judgment-trace/'))
          throw new Error('Trace unavailable');
        if (
          String(file).includes('/evidence/semantic-judgment/') &&
          String(file).endsWith('attempt-000001.json')
        ) {
          const envelope = JSON.parse(String(data));
          address = {
            evaluation_key: envelope.parent_key,
            effect_key: envelope.effect_key,
            attempt: envelope.attempt,
            content_hash: envelope.content_hash,
          };
        }
        return original(file, data, options);
      });
      vi.spyOn(json, 'appendJsonLine').mockImplementation((file, row) => {
        if (
          failure === 'evidence-index' &&
          (row as { artifact_class?: string }).artifact_class === 'evidence'
        )
          throw new Error('Index unavailable');
        return append(file, row);
      });
      expect(write(f)).toMatchObject({ status: 'unavailable' });
      expect(address).toBeDefined();
      vi.restoreAllMocks();
      const before = artifactBytes();
      const writer = vi.spyOn(store, 'writeScopedArtifactAttempt');
      // A missing required index is refused; a registered payload with no trace is integrity-only auditable.
      expect(audit(f, address)).toMatchObject({
        status: failure === 'trace-write' ? 'historical_verified' : 'unavailable',
      });
      expect(writer).not.toHaveBeenCalled();
      expect(artifactBytes()).toEqual(before);
    }
  );
});
