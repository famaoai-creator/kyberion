/** Actual scoped receipts/admission/claim; eligibility observation never invokes a pipeline. */
import * as path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { DotCharter } from './dot-charter.js';
import type {
  DotJudgmentExecutionState,
  DotJudgmentPreEffectDeps,
} from './dot-judgment-pre-effect.js';
import type { SemanticVerdict } from '../organization/judgment-contract.js';
import type { AutonomousOpsGateResult } from '../governance/autonomous-ops-gate.js';
const notifications = vi.hoisted(() => ({ notify: vi.fn(() => true) }));
vi.mock('../surface/operator-notifications.js', async (original) => ({
  ...(await original<typeof import('../surface/operator-notifications.js')>()),
  notifyOperatorSync: notifications.notify,
}));
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const root = path.join(sourceRoot, 'active/shared/tmp', `vitest-pre-effect-${randomUUID()}`);
const baseTime = Date.parse('2026-10-31T00:00:00.000Z');
let bootstrap: typeof import('../secure-io.js');
let io: typeof import('../secure-io.js');
let pre: typeof import('./dot-judgment-pre-effect.js');
let dispatch: typeof import('./dot-dispatch.js');
let actions: typeof import('./dot-action-ledger.js');
let coordination: typeof import('../workforce/work-coordination.js');
let ledger: typeof import('../workforce/work-coordination-ledger.js');
let approvals: typeof import('../governance/approval-store.js');
let routing: typeof import('../governance/approval-decision-routing.js');
let bindings: typeof import('./dot-judgment-binding.js');
let latency: typeof import('../organization/judgment-latency-fixture.js');
let precedents: typeof import('../organization/judgment-precedents.js');
let validation: typeof import('../organization/judgment-validation.js');
let semantic: typeof import('../organization/semantic-judgment.js');
let evidence: typeof import('../organization/judgment-evidence.js');
let proposals: typeof import('./dot-proposals.js');
let charterModule: typeof import('./dot-charter.js');
let roles: typeof import('../organization/authority-role-registry.js');
let gateModule: typeof import('../governance/autonomous-ops-gate.js');
let store: typeof import('../workforce/artifact-store.js');
let serial = 0;
let policyPath: string;

beforeAll(async () => {
  bootstrap = await import('../secure-io.js');
  bootstrap.safeMkdir(root, { recursive: true });
  const copy = (from: string, to: string): void => {
    if (bootstrap.safeLstat(from).isDirectory()) {
      bootstrap.safeMkdir(to, { recursive: true });
      for (const name of bootstrap.safeReaddir(from))
        copy(path.join(from, name), path.join(to, name));
    } else bootstrap.safeCopyFileSync(from, to);
  };
  for (const name of ['schemas', 'governance', 'orchestration'])
    copy(
      path.join(sourceRoot, 'knowledge/product', name),
      path.join(root, 'knowledge/product', name)
    );
  policyPath = path.join(root, 'knowledge/product/governance/autonomous-ops-policy.json');
  const policy = JSON.parse(bootstrap.safeReadFile(policyPath, { encoding: 'utf8' }) as string);
  policy.actions.dot_delegate_work.axis_scores = {
    scope: 0,
    reversibility: 0,
    sensitivity: 0,
    confidence: 0,
  };
  bootstrap.safeWriteFile(policyPath, JSON.stringify(policy));
  bootstrap.safeMkdir(path.join(root, 'knowledge/personal/tenants'), { recursive: true });
  bootstrap.safeWriteFile(
    path.join(root, 'knowledge/personal/tenants/synthetic-latency.json'),
    JSON.stringify({
      tenant_slug: 'synthetic-latency',
      display_name: 'Synthetic fixture',
      status: 'active',
      assigned_role: 'owner',
    })
  );
  bootstrap.safeWriteFile(path.join(root, 'package.json'), '{}');
  vi.stubEnv('KYBERION_ROOT', root);
  vi.stubEnv('KYBERION_PERSONA', 'sovereign');
  vi.stubEnv('MISSION_ROLE', 'mission_controller');
  vi.stubEnv('KYBERION_TENANT', 'synthetic-latency');
  vi.stubEnv('SYSTEM_ROLE', 'operator_surface');
  // Exercise the actual existing staged claim API; this is not production NHI qualification.
  vi.stubEnv('KYBERION_NHI_ACTOR', 'warn');
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(baseTime);
  io = await import('../secure-io.js');
  const { saveProjectRecord } = await import('../project/project-registry.js');
  saveProjectRecord({
    project_id: 'synthetic-project',
    name: 'Fixture',
    summary: 'Pre-effect observation',
    status: 'active',
    tier: 'confidential',
    tenant_slug: 'synthetic-latency',
    organization_id: 'synthetic-org',
  } as Parameters<typeof saveProjectRecord>[0]);
  pre = await import('./dot-judgment-pre-effect.js');
  dispatch = await import('./dot-dispatch.js');
  actions = await import('./dot-action-ledger.js');
  coordination = await import('../workforce/work-coordination.js');
  ledger = await import('../workforce/work-coordination-ledger.js');
  approvals = await import('../governance/approval-store.js');
  routing = await import('../governance/approval-decision-routing.js');
  bindings = await import('./dot-judgment-binding.js');
  latency = await import('../organization/judgment-latency-fixture.js');
  precedents = await import('../organization/judgment-precedents.js');
  validation = await import('../organization/judgment-validation.js');
  semantic = await import('../organization/semantic-judgment.js');
  evidence = await import('../organization/judgment-evidence.js');
  proposals = await import('./dot-proposals.js');
  charterModule = await import('./dot-charter.js');
  roles = await import('../organization/authority-role-registry.js');
  gateModule = await import('../governance/autonomous-ops-gate.js');
  store = await import('../workforce/artifact-store.js');
});
afterEach(() => {
  vi.restoreAllMocks();
  coordination?.clearWorkCoordinationNamespace();
  vi.setSystemTime(baseTime);
});
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  bootstrap?.safeRmSync(root, { recursive: true, force: true });
  vi.resetModules();
});

async function fixture(
  options: {
    approve?: boolean;
    origin?: SemanticVerdict['disposition'];
    latest?: SemanticVerdict['disposition'];
  } = {}
) {
  const data = latency.createJudgmentLatencyFixture();
  const id = `pre-effect-${++serial}`;
  coordination.setWorkCoordinationNamespace(id);
  const clock = { time: baseTime };
  const now = () => new Date(clock.time);
  const advance = (ms: number) => {
    clock.time += ms;
    vi.setSystemTime(clock.time);
  };
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
  if (snapshot.status !== 'ready') throw new Error('Fixture snapshot unavailable');
  const configuredFacts = latency.resolveSyntheticLatencyProposal('repair_fixture');
  if (configuredFacts.status !== 'ready') throw new Error('Fixture candidate unavailable');
  const modelInput = validation.buildJudgmentModelInput(snapshot.snapshot, configuredFacts.facts, [
    { evidence_key: 'synthetic-report', text: data.untrusted_report.text },
  ]);
  const modelConfig = {
    provider: 'fixture-provider',
    model: 'fixture-model',
    maxOutputTokens: 256,
  };
  const binding = {
    schema_version: '1' as const,
    work_ref: id,
    work_revision: '1',
    trigger_key: 'fixture-trigger',
    scope_hash: snapshot.snapshot.scope_hash,
    ...validation.judgmentModelInputHashes(modelInput),
    precedent_snapshot_hash: snapshot.snapshot.snapshot_hash,
    policy_version: 'semantic-policy',
    rubric_version: 'rubric',
    evaluator_version: 'evaluator',
    model_config_hash: semantic.semanticJudgmentModelConfigHash(modelConfig),
  };
  const request = {
    context: {
      binding,
      scope: data.scope,
      modelInput,
      snapshot: snapshot.snapshot,
      requiredGoalKeys: snapshot.snapshot.goals.map((goal) => goal.goal_key),
      knownProposalKeys: ['repair_fixture'],
    },
    effectRef: `effect-${id}`,
    modelConfig,
  };
  let current = { expectedBinding: binding, currentSnapshot: snapshot };
  const invoke = vi.fn(async (disposition: SemanticVerdict['disposition']) => ({
    text: JSON.stringify(
      disposition === 'apply_precedent'
        ? {
            disposition,
            precedent_keys: snapshot.snapshot.evidence_refs.map((ref) => ref.source_key),
            rationale: 'Preserve original goals',
            applicability: ['Synthetic fixture'],
          }
        : disposition === 'reframe'
          ? {
              disposition,
              violated_goal_keys: request.context.requiredGoalKeys,
              rationale: 'Need more fixture evidence',
              revised_question: 'How can the original goal be retained?',
              evidence_needed: [],
            }
          : {
              disposition,
              rationale: 'Value decision needed',
              question: 'Which original value has priority?',
              options: [
                { label: 'Keep goal', consequences: 'Investigate' },
                { label: 'Keep zero cost', consequences: 'Investigate' },
              ],
              missing_facts: [],
            }
    ),
    usage: { input_tokens: 40, output_tokens: 30 },
  }));
  const save = async (disposition: SemanticVerdict['disposition']) => {
    const result = await semantic.assessSemanticJudgment(
      {
        ...request.context,
        mode: 'offline_fixture',
        parentDeadlineMs: clock.time + 15_000,
        parentTokenAllowance: 1000,
        maxOutputTokens: modelConfig.maxOutputTokens,
      },
      {
        now: () => clock.time,
        schedule: () => () => undefined,
        readCurrentContext: () => current,
        port: {
          mode: 'offline_fixture',
          provider: modelConfig.provider,
          model: modelConfig.model,
          invoke: () => invoke(disposition),
        },
      }
    );
    const saved = evidence.saveJudgmentEvidence(
      { ...request, result, parentTokenAllowance: 1000 },
      { now: () => clock.time, readCurrentContext: () => current }
    );
    if (saved.status !== 'persisted')
      throw new Error(JSON.stringify({ assessment: result.assessment, saved }));
    return saved;
  };
  const origin = await save(options.origin ?? 'apply_precedent');
  let latest = origin;
  if (options.latest !== undefined) {
    advance(5 * 60_000);
    latest = await save(options.latest);
  }
  const charter: DotCharter = {
    ...structuredClone(data.charter),
    dot_id: id,
    attention: { triggers: [{ kind: 'cron', cron: '*/15 * * * *' }] },
    authority: {
      ...data.charter.authority,
      authority_role: 'infrastructure_sentinel',
      max_concurrent_delegations: 2,
    },
    ...(options.approve ? { decisions: { default_decision: 'approve' as const } } : {}),
    runtime: { heartbeat_id: id, semantic_judgment: { mode: 'off' } },
  };
  const charterPath = path.join(root, 'active/shared/tmp/fixture-charters', `${id}.json`);
  io.safeMkdir(path.dirname(charterPath), { recursive: true });
  io.safeWriteFile(charterPath, JSON.stringify(charter));
  const proposal = proposals.normalizeDotProposal({
    title: 'Fixed synthetic repair',
    objective: 'Retain the immutable original constraints',
    work_shape: 'pipeline',
    pipeline_ref: latency.SYNTHETIC_LATENCY_PIPELINE_REF,
    target: 'service:synthetic-latency-service',
    intent: 'apply',
  });
  const bound = bindings.bindSyntheticDotJudgmentProposal({
    mode: 'synthetic_fixture',
    charter,
    proposal,
    scope: data.scope,
    judgmentBinding: binding,
    originReceipt: origin.reference.address,
    effectRef: request.effectRef,
    effectPolicyVersion: gateModule.getAutonomousOpsPolicy().version,
  });
  const businessDeps = {
    rootDir: root,
    operationKey: 'original-wake',
    now,
    route: (input: Parameters<typeof routing.routeAutonomousDecision>[0]) =>
      routing.routeAutonomousDecision({ ...input, expiresInMinutes: 1 }),
    feedback: { onRejection: vi.fn() },
  };
  let action = dispatch.dispatchDotProposals(charter, [bound], businessDeps).records[0];
  if (options.approve) {
    const pending = approvals.loadApprovalRequest('autonomy', action.request_id!)!;
    approvals.decideApprovalRequest('infrastructure_sentinel', {
      channel: pending.channel,
      storageChannel: 'autonomy',
      requestId: pending.id,
      decision: 'approved',
      decidedBy: 'user:fixture-owner',
      decidedByType: 'human',
      authenticated: true,
      authMethod: 'surface_session',
      deciderIdentitySource: 'server_resolved',
      presentedDigest: approvals.computeApprovalPresentedDigest(pending),
      deciderPrincipal: {
        actor: { kind: 'human', id: 'user:fixture-owner' },
        source: 'oidc',
        provider: 'offline-fixture-surface',
        principalId: 'user:fixture-owner',
      },
    });
    action = dispatch.settleDotParkedActions(charter, businessDeps)[0];
  }
  expect(action.status).toBe('dispatched');
  const item = coordination.getWorkItem(action.work_item_id!, { rootDir: root })!;
  const claimed = coordination.claimWorkItem({
    itemId: item.item_id,
    actorPeerId: dispatch.dotActorId(id),
    purpose: 'synthetic-pre-effect',
    expectedVersion: item.version,
    ttlMs: 20 * 60_000,
    idempotencyKey: 'fixture-claim',
  });
  const input = {
    mode: 'synthetic_fixture' as const,
    dot_id: id,
    action_ref: action.action_ref,
    item_id: item.item_id,
    lease_id: claimed.lease.lease_id,
    run_id: claimed.item.current_attempt_id!,
    expected_item_version: claimed.item.version,
  };
  const read = (): DotJudgmentExecutionState => ({
    charter: charterModule.rereadOwnDotCharter({ path: charterPath, charter }),
    action: actions
      .currentDotActions(id, { rootDir: root })
      .find((row) => row.action_ref === input.action_ref)!,
    item: coordination.getWorkItem(input.item_id, { rootDir: root })!,
    lease: ledger.withCoordinationRoot(
      root,
      () =>
        coordination.listActiveWorkLeases().find((lease) => lease.lease_id === input.lease_id) ??
        null
    ),
  });
  const configuredProposalHash = precedents.judgmentCanonicalHash(bound);
  const deps: DotJudgmentPreEffectDeps = {
    now: () => clock.time,
    readExecutionState: vi.fn(read),
    resolveTrustedEffect: vi.fn((original) => {
      if (precedents.judgmentCanonicalHash(original) !== configuredProposalHash)
        throw new Error('Unknown configured operation');
      return { request, proposalFacts: configuredFacts.facts, goals: snapshot.snapshot.goals };
    }),
    readCurrentContext: () => current,
    hasRole: (role) => Boolean(roles.loadAuthorityRoleIndex(root)[role]),
    checkBounds: (currentCharter, original) =>
      dispatch.checkDotProposalBounds(currentCharter, original, { rootDir: root, now }),
    evaluateGate: (currentCharter, original) =>
      dispatch.evaluateDotProposalGate(currentCharter, original, { rootDir: root, now }).gate,
    readEffectPolicyVersion: () => gateModule.getAutonomousOpsPolicy().version,
    loadApproval: (id) => approvals.loadApprovalRequest('autonomy', id),
  };
  return {
    data,
    request,
    origin,
    latest,
    charter,
    charterPath,
    bound,
    input,
    deps,
    read,
    advance,
    clock,
    invoke,
    changeBinding: () => {
      current = { ...current, expectedBinding: { ...binding, work_revision: 'changed' } };
    },
    changeDecision: () => {
      current = {
        ...current,
        currentSnapshot: {
          status: 'unavailable',
          reason: 'missing_evidence',
          detail: 'Changed source',
        } as typeof snapshot,
      };
    },
  };
}

describe('observed synthetic pre-effect eligibility from actual owned stores', () => {
  it('observes actual claimed ownership without changing business state or invoking another model', async () => {
    const f = await fixture();
    const before = f.read();
    const calls = f.invoke.mock.calls.length;
    const claim = vi.spyOn(coordination, 'claimWorkItem'),
      release = vi.spyOn(coordination, 'releaseWorkItem');
    const notificationCount = notifications.notify.mock.calls.length;
    const result = pre.validateDotJudgmentPreEffect(f.input, f.deps);
    expect(
      result,
      JSON.stringify({
        role: f.deps.hasRole(before.charter.authority.authority_role),
        bounds: f.deps.checkBounds(before.charter, f.bound),
        gate: f.deps.evaluateGate(before.charter, f.bound),
        stateReads: vi.mocked(f.deps.readExecutionState).mock.calls.length,
        mappings: vi.mocked(f.deps.resolveTrustedEffect).mock.calls.length,
      })
    ).toMatchObject({
      status: 'eligible_observed',
      actor_id: dispatch.dotActorId(f.input.dot_id),
      authority_role: 'infrastructure_sentinel',
      origin_receipt: f.origin.reference.address,
      latest_receipt: f.latest.reference,
    });
    expect(result).not.toHaveProperty('allowed');
    expect(result).not.toHaveProperty('authorization');
    expect(f.read()).toEqual(before);
    expect(claim).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(f.invoke).toHaveBeenCalledTimes(calls);
    expect(notifications.notify.mock.calls.length).toBe(notificationCount);
    expect(before.item.current_attempt_id).toBe(before.item.attempts![0].run_id);
    expect(before.item.current_attempt_id).not.toBe(before.item.attempts![0].attempt_id);
    expect(before.lease!.expected_version).toBe(before.item.version - 1);
  });
  it('audits expired immutable origin1 and uses current apply attempt2 without replacing the original selector', async () => {
    const f = await fixture({ latest: 'apply_precedent' });
    const original = JSON.stringify(f.bound);
    const result = pre.validateDotJudgmentPreEffect(f.input, f.deps);
    expect(result).toMatchObject({
      status: 'eligible_observed',
      origin_receipt: { attempt: 1 },
      latest_receipt: { address: { attempt: 2 } },
    });
    expect(JSON.stringify(f.bound)).toBe(original);
  });
  it('accepts a current actual approve/allowedfalse floor only with exact usable stored human decision', async () => {
    const f = await fixture({ approve: true });
    const gate = f.deps.evaluateGate(f.read().charter, f.bound);
    expect(gate).toMatchObject({
      decision: 'approve',
      allowed: false,
      score: 0,
      executionMode: 'apply',
      shadow: false,
    });
    expect(pre.validateDotJudgmentPreEffect(f.input, f.deps).status).toBe('eligible_observed');
    const load = f.deps.loadApproval;
    f.deps.loadApproval = (id) => {
      const approval = load(id)!;
      return { ...approval, accountability: undefined };
    };
    expect(pre.validateDotJudgmentPreEffect(f.input, f.deps).status).toBe('unavailable');
  });
  it.each(['reframe'] as const)(
    'refuses original %s despite a later apply verdict',
    async (origin) => {
      const f = await fixture({ origin, latest: 'apply_precedent' });
      expect(pre.validateDotJudgmentPreEffect(f.input, f.deps).status).toBe('unavailable');
    }
  );
  it.each(['origin', 'latest'] as const)(
    'rejects an invalid occupied %s escalate payload rather than weakening the zero-cost verdict contract',
    async (which) => {
      const f = await fixture({ latest: 'apply_precedent' });
      const reference = which === 'origin' ? f.origin.reference : f.latest.reference;
      const file = path.join(root, reference.artifact_ref);
      const envelope = JSON.parse(io.safeReadFile(file, { encoding: 'utf8' }) as string);
      envelope.content.assessment.verdict = {
        disposition: 'escalate',
        rationale: 'Unsupported new tradeoff',
        question: 'Change the fixed goal?',
        options: [
          { label: 'Keep', consequences: 'Keep' },
          { label: 'Change', consequences: 'Change' },
        ],
        missing_facts: [],
      };
      envelope.content_hash = createHash('sha256')
        .update(JSON.stringify(envelope.content), 'utf8')
        .digest('hex');
      io.safeWriteFile(file, JSON.stringify(envelope));
      expect(
        evidence.readHistoricalJudgmentEvidence({
          scope: f.data.scope,
          binding: f.request.context.binding,
          effectRef: f.request.effectRef,
          address: { ...reference.address, content_hash: envelope.content_hash },
        }).status
      ).toBe('unavailable');
      expect(pre.validateDotJudgmentPreEffect(f.input, f.deps).status).toBe('unavailable');
    }
  );
  it.each(['reframe'] as const)(
    'refuses current latest %s despite original apply',
    async (latest) => {
      const f = await fixture({ latest });
      expect(pre.validateDotJudgmentPreEffect(f.input, f.deps).status).toBe('unavailable');
    }
  );
  it.each(['missing', 'corrupt'] as const)(
    'refuses %s actual origin payload',
    async (condition) => {
      const f = await fixture({ latest: 'apply_precedent' });
      const file = path.join(root, f.origin.reference.artifact_ref);
      if (condition === 'missing') io.safeRmSync(file);
      else io.safeWriteFile(file, '{}');
      expect(pre.validateDotJudgmentPreEffect(f.input, f.deps).status).toBe('unavailable');
    }
  );
  it.each(['missing', 'corrupt'] as const)('refuses %s latest payload', async (condition) => {
    const f = await fixture({ latest: 'apply_precedent' });
    const file = path.join(root, f.latest.reference.artifact_ref);
    if (condition === 'missing') io.safeRmSync(file);
    else io.safeWriteFile(file, '{}');
    expect(pre.validateDotJudgmentPreEffect(f.input, f.deps).status).toBe('unavailable');
  });
  it.each(['facts', 'goals', 'effect', 'model', 'binding', 'source'] as const)(
    'refuses changed trusted %s mapping/context',
    async (condition) => {
      const f = await fixture();
      const resolve = f.deps.resolveTrustedEffect;
      if (condition === 'binding') f.changeBinding();
      else if (condition === 'source') f.changeDecision();
      else
        f.deps.resolveTrustedEffect = (original) => {
          const value = structuredClone(resolve(original));
          if (condition === 'facts') value.proposalFacts.requested_goal.target_users = 65;
          if (condition === 'goals')
            value.goals = value.goals.map((goal) => ({ ...goal, max_p95_ms: 1800 }));
          if (condition === 'effect') value.request.effectRef = 'different-effect';
          if (condition === 'model') value.request.modelConfig.model = 'different-model';
          return value;
        };
      expect(pre.validateDotJudgmentPreEffect(f.input, f.deps).status).toBe('unavailable');
    }
  );
  it.each([
    'wrong-action',
    'wrong-policy',
    'wrong-tenant',
    'dry_run',
    'observe',
    'shadow',
    'false-auto',
    'negative-score',
    'negative-max',
    'infinite-score',
    'nan-max',
    'null-prototype',
    'own-proto',
  ] as const)('refuses malformed or denied gate %s', async (condition) => {
    const f = await fixture();
    const evaluate = f.deps.evaluateGate;
    f.deps.evaluateGate = (charter, original) => {
      const gate = { ...evaluate(charter, original) };
      if (condition === 'wrong-action') gate.actionId = f.bound.action_id; // Known but wrong admission mapping.
      if (condition === 'wrong-policy') gate.policyVersion = 'other';
      if (condition === 'wrong-tenant') gate.tenantSlug = 'other-tenant';
      if (condition === 'dry_run' || condition === 'observe')
        gate.executionMode = condition as AutonomousOpsGateResult['executionMode'];
      if (condition === 'shadow') gate.shadow = true;
      if (condition === 'false-auto') gate.allowed = false;
      if (condition === 'negative-score') gate.score = -1;
      if (condition === 'negative-max') gate.maxScore = -1;
      if (condition === 'infinite-score') gate.score = Infinity;
      if (condition === 'nan-max') gate.maxScore = NaN;
      if (condition === 'null-prototype') Object.setPrototypeOf(gate, null);
      if (condition === 'own-proto')
        Object.defineProperty(gate, '__proto__', { value: {}, enumerable: true });
      return gate;
    };
    expect(pre.validateDotJudgmentPreEffect(f.input, f.deps).status).toBe('unavailable');
  });
  it('rejects actual unknown-action and invalid-policy Infinity hard refusals, not approval floors', async () => {
    const f = await fixture({ approve: true });
    const unknown = gateModule.evaluateAutonomousOpsAction({
      actionId: 'unknown-synthetic-action',
      tenantSlug: f.data.scope.tenant_slug,
    });
    expect(unknown.score).toBe(Infinity);
    f.deps.evaluateGate = () => unknown;
    expect(pre.validateDotJudgmentPreEffect(f.input, f.deps).status).toBe('unavailable');
    const bytes = io.safeReadFile(policyPath, { encoding: 'utf8' }) as string;
    try {
      io.safeWriteFile(policyPath, '{ invalid');
      const invalid = gateModule.evaluateAutonomousOpsAction({
        actionId: f.bound.action_id,
        tenantSlug: f.data.scope.tenant_slug,
      });
      expect(invalid.score).toBe(Infinity);
      f.deps.readEffectPolicyVersion = () => f.bound.semantic_judgment.effect_policy_version;
      f.deps.evaluateGate = () => invalid;
      expect(pre.validateDotJudgmentPreEffect(f.input, f.deps).status).toBe('unavailable');
    } finally {
      io.safeWriteFile(policyPath, bytes);
    }
  });
  it.each(['missing-class', 'wrong-id'] as const)(
    'rejects forged %s intake metadata even when item metadata mirrors it',
    async (condition) => {
      const f = await fixture();
      const read = f.deps.readExecutionState;
      const evaluate = vi.fn(f.deps.evaluateGate);
      f.deps.evaluateGate = evaluate;
      f.deps.readExecutionState = () => {
        const state = structuredClone(read());
        if (condition === 'missing-class') {
          delete state.action.admission_only;
          delete state.action.gate_action_id;
          delete state.item.metadata!.admission_only;
          delete state.item.metadata!.gate_action_id;
        } else {
          state.action.gate_action_id = 'other-action';
          state.item.metadata!.gate_action_id = 'other-action';
        }
        return state;
      };
      expect(pre.validateDotJudgmentPreEffect(f.input, f.deps).status).toBe('unavailable');
      expect(evaluate).toHaveBeenCalled();
    }
  );
  it('refuses stale intake metadata after the canonical policy stops classifying the proposal as intake', async () => {
    const f = await fixture();
    const file = path.join(root, 'knowledge/product/governance/dot-execution-policy.json');
    const bytes = io.safeReadFile(file, { encoding: 'utf8' }) as string;
    try {
      const policy = JSON.parse(bytes);
      policy.intake.enabled = false;
      io.safeWriteFile(file, JSON.stringify(policy));
      expect(pre.validateDotJudgmentPreEffect(f.input, f.deps).status).toBe('unavailable');
    } finally {
      io.safeWriteFile(file, bytes);
    }
  });
  it('fingerprints the canonical execution-policy descriptor across trace adoption', async () => {
    const f = await fixture();
    const file = path.join(root, 'knowledge/product/governance/dot-execution-policy.json');
    const bytes = io.safeReadFile(file, { encoding: 'utf8' }) as string;
    const write = store.writeScopedArtifactAttempt;
    let traces = 0;
    vi.spyOn(store, 'writeScopedArtifactAttempt').mockImplementation((input) => {
      const result = write(input);
      if (input.namespace === 'semantic-judgment-trace' && ++traces === 2) {
        const policy = JSON.parse(bytes);
        policy.version = '1.0.1';
        io.safeWriteFile(file, JSON.stringify(policy));
      }
      return result;
    });
    try {
      expect(pre.validateDotJudgmentPreEffect(f.input, f.deps).status).toBe('unavailable');
      expect(traces).toBe(2);
    } finally {
      io.safeWriteFile(file, bytes);
    }
  });
  it.each(['role', 'bounds'] as const)(
    'requires independent current %s even with a usable approved effect',
    async (condition) => {
      const f = await fixture({ approve: true });
      if (condition === 'role') f.deps.hasRole = () => false;
      else f.deps.checkBounds = () => ({ ok: false, reason: 'No longer bounded' });
      expect(pre.validateDotJudgmentPreEffect(f.input, f.deps).status).toBe('unavailable');
    }
  );
  it.each(['lease', 'run', 'peer', 'version', 'scope', 'metadata'] as const)(
    'refuses wrong current %s without changing the actual claim',
    async (condition) => {
      const f = await fixture();
      const before = f.read();
      f.deps.readExecutionState = () => {
        const value = structuredClone(before);
        if (condition === 'lease') value.lease!.lease_id = 'other-lease';
        if (condition === 'run') value.item.current_attempt_id = value.item.attempts![0].attempt_id;
        if (condition === 'peer')
          value.lease!.holder_peer_id = value.charter.authority.authority_role;
        if (condition === 'version') value.item.version++;
        if (condition === 'scope') value.item.context!.tenant_slug = 'other-tenant';
        if (condition === 'metadata') delete value.item.metadata!.semantic_judgment;
        return value;
      };
      expect(pre.validateDotJudgmentPreEffect(f.input, f.deps).status).toBe('unavailable');
      expect(f.read()).toEqual(before);
    }
  );
  it('rejects actual released and expired claims without releasing or reacquiring on its own', async () => {
    const f = await fixture();
    coordination.releaseWorkItem({
      itemId: f.input.item_id,
      leaseId: f.input.lease_id,
      actorPeerId: dispatch.dotActorId(f.input.dot_id),
      nextStatus: 'ready',
    });
    expect(pre.validateDotJudgmentPreEffect(f.input, f.deps).status).toBe('unavailable');
    const expired = await fixture();
    expired.advance(20 * 60_000 + 1);
    expect(pre.validateDotJudgmentPreEffect(expired.input, expired.deps).status).toBe(
      'unavailable'
    );
  });
  it.each(['trace', 'gate', 'approval'] as const)(
    'rereads actual item/context after mutable %s boundary',
    async (boundary) => {
      const f = await fixture({ approve: boundary === 'approval' });
      let changed = false;
      const mutate = () => {
        if (!changed) {
          changed = true;
          const item = coordination.getWorkItem(f.input.item_id, { rootDir: root })!;
          coordination.updateWorkItem({
            rootDir: root,
            itemId: item.item_id,
            expectedVersion: item.version,
            title: 'Changed after authority read',
          });
        }
      };
      if (boundary === 'trace') {
        const write = store.writeScopedArtifactAttempt;
        vi.spyOn(store, 'writeScopedArtifactAttempt').mockImplementation((input) => {
          const result = write(input);
          if (input.namespace === 'semantic-judgment-trace') mutate();
          return result;
        });
      }
      if (boundary === 'gate') {
        const evaluate = f.deps.evaluateGate;
        f.deps.evaluateGate = (charter, original) => {
          const gate = evaluate(charter, original);
          mutate();
          return gate;
        };
      }
      if (boundary === 'approval') {
        const load = f.deps.loadApproval;
        f.deps.loadApproval = (id) => {
          const result = load(id);
          mutate();
          return result;
        };
      }
      expect(pre.validateDotJudgmentPreEffect(f.input, f.deps).status).toBe('unavailable');
      expect(changed).toBe(true);
    }
  );
  it.each(['receipt', 'approval'] as const)(
    'rejects crossing final %s TTL even while the claimed lease remains live',
    async (expiry) => {
      const f = await fixture({ approve: expiry === 'approval' });
      let reads = 0;
      f.deps.readExecutionState = () => {
        if (++reads === 2) f.advance(expiry === 'receipt' ? 5 * 60_000 + 1 : 60_000 + 1);
        return f.read();
      };
      expect(pre.validateDotJudgmentPreEffect(f.input, f.deps).status).toBe('unavailable');
      expect(f.read().lease?.status).toBe('active');
      expect(reads).toBe(2);
    }
  );
  it('rejects input extensions, stale versions and a regressing shared clock', async () => {
    const f = await fixture();
    expect(
      pre.validateDotJudgmentPreEffect(
        { ...f.input, route: 'model-owned' } as typeof f.input,
        f.deps
      ).status
    ).toBe('unavailable');
    expect(
      pre.validateDotJudgmentPreEffect(
        { ...f.input, expected_item_version: f.input.expected_item_version - 1 },
        f.deps
      ).status
    ).toBe('unavailable');
    let calls = 0;
    f.deps.now = () => f.clock.time - calls++;
    expect(pre.validateDotJudgmentPreEffect(f.input, f.deps).status).toBe('unavailable');
  });
  it.each(['clock', 'approval'] as const)(
    'quarantines a malformed rejected async %s read port without an unhandled rejection',
    async (port) => {
      const f = await fixture({ approve: port === 'approval' });
      if (port === 'clock')
        f.deps.now = (() =>
          Promise.reject(new Error('Bad sync clock'))) as unknown as typeof f.deps.now;
      else
        f.deps.loadApproval = (() =>
          Promise.reject(new Error('Bad sync reader'))) as unknown as typeof f.deps.loadApproval;
      expect(pre.validateDotJudgmentPreEffect(f.input, f.deps).status).toBe('unavailable');
      await Promise.resolve();
    }
  );
});
