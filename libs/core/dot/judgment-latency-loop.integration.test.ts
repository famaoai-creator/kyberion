/** Actual admission/claims/executor with a synthetic file port, never a production ADF adapter. */
import * as path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { DotCharter } from './dot-charter.js';
import type { DotJudgmentPreEffectDeps } from './dot-judgment-pre-effect.js';
import type { SyntheticLatencyExecutionProof } from '../organization/judgment-latency-verification.js';
import type { WorkItem } from '../workforce/work-coordination-types.js';
const notifications = vi.hoisted(() => ({ notify: vi.fn(() => true) }));
vi.mock('../surface/operator-notifications.js', async (original) => ({
  ...(await original<typeof import('../surface/operator-notifications.js')>()),
  notifyOperatorSync: notifications.notify,
}));
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const root = path.join(sourceRoot, 'active/shared/tmp', `vitest-latency-loop-${randomUUID()}`);
const baseTime = Date.parse('2026-10-31T00:00:00.000Z');
let bootstrap: typeof import('../secure-io.js');
let io: typeof import('../secure-io.js');
let pre: typeof import('./dot-judgment-pre-effect.js');
let dispatch: typeof import('./dot-dispatch.js');
let executor: typeof import('./dot-executor.js');
let actions: typeof import('./dot-action-ledger.js');
let coordination: typeof import('../workforce/work-coordination.js');
let ledger: typeof import('../workforce/work-coordination-ledger.js');
let approvals: typeof import('../governance/approval-store.js');
let bindings: typeof import('./dot-judgment-binding.js');
let latency: typeof import('../organization/judgment-latency-fixture.js');
let verification: typeof import('../organization/judgment-latency-verification.js');
let precedents: typeof import('../organization/judgment-precedents.js');
let validation: typeof import('../organization/judgment-validation.js');
let semantic: typeof import('../organization/semantic-judgment.js');
let evidence: typeof import('../organization/judgment-evidence.js');
let proposals: typeof import('./dot-proposals.js');
let charterModule: typeof import('./dot-charter.js');
let roles: typeof import('../organization/authority-role-registry.js');
let gateModule: typeof import('../governance/autonomous-ops-gate.js');
let identity: typeof import('../workforce/work-coordination-identity.js');
let workItemInput: typeof import('./dot-work-item.js');
let json: typeof import('../foundation/json.js');
let resultFile: string;
let serial = 0;
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

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
  const policyPath = path.join(root, 'knowledge/product/governance/autonomous-ops-policy.json');
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
  // Existing staged claim API only; this fixture does not qualify production NHI authentication.
  vi.stubEnv('KYBERION_NHI_ACTOR', 'warn');
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(baseTime);
  io = await import('../secure-io.js');
  const { saveProjectRecord } = await import('../project/project-registry.js');
  saveProjectRecord({
    project_id: 'synthetic-project',
    name: 'Fixture',
    summary: 'Synthetic loop',
    status: 'active',
    tier: 'confidential',
    tenant_slug: 'synthetic-latency',
    organization_id: 'synthetic-org',
  } as Parameters<typeof saveProjectRecord>[0]);
  pre = await import('./dot-judgment-pre-effect.js');
  dispatch = await import('./dot-dispatch.js');
  executor = await import('./dot-executor.js');
  actions = await import('./dot-action-ledger.js');
  coordination = await import('../workforce/work-coordination.js');
  ledger = await import('../workforce/work-coordination-ledger.js');
  approvals = await import('../governance/approval-store.js');
  bindings = await import('./dot-judgment-binding.js');
  latency = await import('../organization/judgment-latency-fixture.js');
  verification = await import('../organization/judgment-latency-verification.js');
  precedents = await import('../organization/judgment-precedents.js');
  validation = await import('../organization/judgment-validation.js');
  semantic = await import('../organization/semantic-judgment.js');
  evidence = await import('../organization/judgment-evidence.js');
  proposals = await import('./dot-proposals.js');
  charterModule = await import('./dot-charter.js');
  roles = await import('../organization/authority-role-registry.js');
  gateModule = await import('../governance/autonomous-ops-gate.js');
  identity = await import('../workforce/work-coordination-identity.js');
  workItemInput = await import('./dot-work-item.js');
  json = await import('../foundation/json.js');
  const state = await import('./dot-state-paths.js');
  resultFile = path.join(
    root,
    state.dotStatePath(
      { scope: latency.createJudgmentLatencyFixture().scope },
      state.DOT_WORK_RESULTS_FILE
    )
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  // The two DOTs in one case intentionally share this fixed-scope journal. Cases do not.
  // Only this known file in our unique isolated root is cleaned; no production/global store is touched.
  if (resultFile) io.safeRmSync(resultFile, { force: true });
  coordination?.clearWorkCoordinationNamespace();
  vi.setSystemTime(baseTime);
});
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  bootstrap?.safeRmSync(root, { recursive: true, force: true });
  vi.resetModules();
});

async function fixture() {
  const data = latency.createJudgmentLatencyFixture();
  const id = `latency-loop-${++serial}`;
  coordination.setWorkCoordinationNamespace(id);
  const now = () => new Date();
  const parent = coordination.createWorkItem({
    rootDir: root,
    itemId: id,
    title: 'Retain all latency goals',
    description:
      'Controller requires independent fixed-condition verification of 100 users, p95 500 ms and zero incremental JPY',
    status: 'ready',
    context: {
      tenant_slug: data.scope.tenant_slug,
      organization_id: data.scope.organization_id,
      project_id: data.scope.project_id,
      work_shape: 'improvement_experiment',
    },
    metadata: { synthetic_controller: true },
  });
  const output = path.join(root, 'active/shared/tmp', id, 'worker', 'configuration.json');
  io.safeMkdir(path.dirname(output), { recursive: true });
  // Independent controller-held constants are never written in the worker-writable directory.
  const expected = verification.syntheticLatencyArtifactBytes(data.configurations.repair);
  if (expected.status !== 'ready') throw new Error('Unknown fixed configuration');
  const trustedMeasurement = latency.syntheticLatencyMeasurementContract();
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
  const facts = latency.resolveSyntheticLatencyProposal('repair_fixture');
  if (facts.status !== 'ready') throw new Error('Unknown fixed candidate');
  const modelInput = validation.buildJudgmentModelInput(snapshot.snapshot, facts.facts, [
    { evidence_key: 'synthetic-report', text: data.untrusted_report.text },
  ]);
  const modelConfig = {
    provider: 'fixture-provider',
    model: 'fixture-model',
    maxOutputTokens: 256,
  };
  async function child(kind: 'repair' | 'verify') {
    const dot = `${id}-${kind}`;
    const binding = {
      schema_version: '1' as const,
      work_ref: parent.item_id,
      work_revision: String(parent.version),
      trigger_key: `${kind}-trigger`,
      scope_hash: snapshot.snapshot.scope_hash,
      ...validation.judgmentModelInputHashes(modelInput),
      precedent_snapshot_hash: snapshot.snapshot.snapshot_hash,
      policy_version: 'semantic-policy',
      rubric_version: 'rubric',
      evaluator_version: 'evaluator',
      model_config_hash: semantic.semanticJudgmentModelConfigHash(modelConfig),
    };
    let current = { expectedBinding: binding, currentSnapshot: snapshot };
    const request = {
      context: {
        binding,
        scope: data.scope,
        modelInput,
        snapshot: snapshot.snapshot,
        requiredGoalKeys: snapshot.snapshot.goals.map((goal) => goal.goal_key),
        knownProposalKeys: ['repair_fixture'],
      },
      effectRef: `${kind}-effect-${id}`,
      modelConfig,
    };
    const judgment = await semantic.assessSemanticJudgment(
      {
        ...request.context,
        mode: 'offline_fixture',
        parentDeadlineMs: Date.now() + 15000,
        parentTokenAllowance: 1000,
        maxOutputTokens: 256,
      },
      {
        now: Date.now,
        schedule: () => () => undefined,
        readCurrentContext: () => current,
        port: {
          mode: 'offline_fixture',
          provider: modelConfig.provider,
          model: modelConfig.model,
          invoke: async () => ({
            text: JSON.stringify({
              disposition: 'apply_precedent',
              precedent_keys: snapshot.snapshot.evidence_refs.map((ref) => ref.source_key),
              rationale: 'Retain every original synthetic goal',
              applicability: ['Fixed synthetic configuration'],
            }),
            usage: { input_tokens: 40, output_tokens: 30 },
          }),
        },
      }
    );
    const origin = evidence.saveJudgmentEvidence(
      { ...request, result: judgment, parentTokenAllowance: 1000 },
      { now: Date.now, readCurrentContext: () => current }
    );
    if (origin.status !== 'persisted') throw new Error('Cannot save actual origin receipt');
    const charter: DotCharter = {
      ...structuredClone(data.charter),
      dot_id: dot,
      attention: { triggers: [{ kind: 'cron', cron: '*/15 * * * *' }] },
      authority: {
        ...data.charter.authority,
        authority_role: 'infrastructure_sentinel',
        max_concurrent_delegations: 2,
      },
      runtime: { heartbeat_id: dot, semantic_judgment: { mode: 'off' } },
    };
    const charterPath = path.join(
      root,
      'knowledge/confidential/synthetic-latency/dots',
      `${dot}.json`
    );
    io.safeMkdir(path.dirname(charterPath), { recursive: true });
    io.safeWriteFile(charterPath, JSON.stringify(charter));
    const proposal = proposals.normalizeDotProposal({
      title: `${kind} fixed synthetic configuration`,
      objective:
        kind === 'repair'
          ? 'Write only fixed parallel configuration'
          : 'Independently verify original goals',
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
    const action = dispatch.dispatchDotProposals(charter, [bound], {
      rootDir: root,
      now,
      operationKey: `${kind}-operation-${id}`,
      feedback: { onRejection: vi.fn() },
    }).records[0];
    expect(action.status).toBe('dispatched');
    const getItem = () => coordination.getWorkItem(action.work_item_id!, { rootDir: root })!;
    const getAction = () =>
      actions
        .currentDotActions(dot, { rootDir: root })
        .find((row) => row.action_ref === action.action_ref)!;
    const hash = precedents.judgmentCanonicalHash(bound);
    const preDeps: DotJudgmentPreEffectDeps = {
      now: Date.now,
      readExecutionState: () => ({
        charter: charterModule.rereadOwnDotCharter({ path: charterPath, charter }),
        action: getAction(),
        item: getItem(),
        lease: ledger.withCoordinationRoot(
          root,
          () =>
            coordination
              .listActiveWorkLeases()
              .find((lease) => lease.lease_id === getItem().lease_id) ?? null
        ),
      }),
      resolveTrustedEffect: (original) => {
        if (precedents.judgmentCanonicalHash(original) !== hash)
          throw new Error('Unknown configured original proposal');
        return { request, proposalFacts: facts.facts, goals: snapshot.snapshot.goals };
      },
      readCurrentContext: () => current,
      hasRole: (role) => Boolean(roles.loadAuthorityRoleIndex(root)[role]),
      checkBounds: (c, p) => dispatch.checkDotProposalBounds(c, p, { rootDir: root, now }),
      evaluateGate: (c, p) => dispatch.evaluateDotProposalGate(c, p, { rootDir: root, now }).gate,
      readEffectPolicyVersion: () => gateModule.getAutonomousOpsPolicy().version,
      loadApproval: (key) => approvals.loadApprovalRequest('autonomy', key),
    };
    return {
      kind,
      charter,
      charterPath,
      bound,
      action,
      getItem,
      getAction,
      preDeps,
      stale: () => {
        current = { ...current, expectedBinding: { ...binding, work_revision: 'changed' } };
      },
    };
  }
  const repair = await child('repair'),
    verifier = await child('verify');
  const writes: string[] = [];
  const forbidden = vi.fn(async (): Promise<never> => {
    throw new Error('Model/delegation forbidden');
  });
  const inbox = vi.fn();
  type Child = typeof repair;
  // Reconstruct from the actual stores, not from a worker-supplied proof DTO or actor label.
  function proof(c: Child, released: boolean): SyntheticLatencyExecutionProof {
    const action = c.getAction(),
      item = c.getItem();
    actions.assertDotActionJudgmentBinding(action);
    const binding = bindings.parseDotJudgmentBinding(action.semantic_judgment)!;
    const history = ledger.withCoordinationRoot(root, () =>
      json.readJsonLines<WorkItem>(ledger.itemsPath()).filter((row) => row.item_id === item.item_id)
    );
    history.forEach(identity.validateWorkItem);
    if (!history.length) throw new Error('Actual WorkItem creation history missing');
    identity.assertOriginalWorkItemIdentity(
      history,
      identity.buildWorkItemCreation(workItemInput.dotWorkItemInput(c.charter, action, root))
    );
    if (
      item.source !== history[0].source ||
      item.source_ref !== history[0].source_ref ||
      item.project_id !== history[0].project_id
    )
      throw new Error('Actual immutable WorkItem source differs');
    const actualCharter = charterModule.rereadOwnDotCharter({
      path: c.charterPath,
      charter: c.charter,
    });
    if (
      bindings.dotJudgmentCharterHash(actualCharter) !== binding.charter_hash ||
      action.dot_id !== actualCharter.dot_id ||
      action.actor_id !== dispatch.dotActorId(actualCharter.dot_id) ||
      precedents.judgmentCanonicalHash(actualCharter.scope) !==
        precedents.judgmentCanonicalHash(data.scope) ||
      (['tenant_slug', 'organization_id', 'project_id', 'mission_id', 'task_id'] as const).some(
        (field) => item.context?.[field] !== parent.context?.[field]
      )
    )
      throw new Error('Actual charter or complete parent scope differs');
    const attempt = item.attempts?.find(
      (attempt) =>
        attempt.run_id === (released ? item.attempts?.at(-1)?.run_id : item.current_attempt_id)
    );
    if (
      !attempt ||
      item.metadata?.action_ref !== action.action_ref ||
      action.work_item_id !== item.item_id ||
      binding.judgment_binding.work_ref !== parent.item_id ||
      !action.admission?.operation_key ||
      precedents.judgmentCanonicalHash(item.metadata?.semantic_judgment) !==
        precedents.judgmentCanonicalHash(binding) ||
      attempt.actor_peer_id !== dispatch.dotActorId(c.charter.dot_id)
    )
      throw new Error('Actual action/item/parent/actor proof differs');
    const lease = ledger.withCoordinationRoot(root, () =>
      ledger.currentLeaseRecords().find((row) => row.lease_id === attempt.lease_id)
    );
    if (
      !lease ||
      lease.item_id !== item.item_id ||
      lease.holder_peer_id !== attempt.actor_peer_id ||
      lease.holder_user_id !== attempt.actor_user_id ||
      lease.status !== (released ? 'released' : 'active') ||
      attempt.status !== (released ? 'released' : 'running')
    )
      throw new Error('Actual lease/attempt proof differs');
    const events = ledger.withCoordinationRoot(root, () =>
      coordination.listCoordinationEvents({ item_id: item.item_id })
    );
    if (
      !events.some(
        (event) =>
          event.event_type === 'item_claimed' &&
          event.lease_id === lease.lease_id &&
          event.actor_peer_id === attempt.actor_peer_id
      )
    )
      throw new Error('Actual claim event missing');
    if (released) {
      const rows = executor.readDotWorkResults(c.charter, { rootDir: root });
      if (
        item.status !== 'done' ||
        !Number.isFinite(Date.parse(lease.released_at ?? '')) ||
        !Number.isFinite(Date.parse(attempt.ended_at ?? '')) ||
        item.effect_ownership?.state !== 'settled' ||
        item.effect_ownership.settlement !== 'completed' ||
        item.effect_ownership.attempt_id !== attempt.run_id ||
        item.effect_ownership.actor_id !== attempt.actor_peer_id ||
        !events.some(
          (event) =>
            event.event_type === 'item_attempt_released' &&
            event.payload?.lease_id === lease.lease_id &&
            event.payload?.run_id === attempt.run_id &&
            event.payload?.actor_peer_id === attempt.actor_peer_id
        ) ||
        !rows.some(
          (row) =>
            row.status === 'done' &&
            row.action_ref === action.action_ref &&
            row.work_item_id === item.item_id &&
            row.attempt_id === attempt.run_id
        )
      )
        throw new Error('Actual completed execution proof missing');
    }
    return {
      work_ref: binding.judgment_binding.work_ref,
      effect_ref: binding.effect_ref,
      action_ref: action.action_ref,
      operation_key: action.admission.operation_key,
      work_item_id: item.item_id,
      claim_actor_id: lease.holder_peer_id,
      lease_id: lease.lease_id,
      run_id: attempt.run_id,
    };
  }
  let verifierResult: ReturnType<typeof verification.verifySyntheticLatencyArtifact> | undefined;
  async function run(c: Child, options: { fail?: boolean; afterCheck?: () => void } = {}) {
    const port = vi.fn(async (_ref: string, ctx: Record<string, unknown>, signal?: AbortSignal) => {
      const item = c.getItem();
      if (
        ctx.work_item_id !== item.item_id ||
        ctx.lease_id !== item.lease_id ||
        ctx.attempt_id !== item.current_attempt_id ||
        signal?.aborted
      )
        throw new executor.DotExecutorPreEffectError('Executor context mismatch', {
          retryable: false,
        });
      const observed = pre.validateDotJudgmentPreEffect(
        {
          mode: 'synthetic_fixture',
          dot_id: c.charter.dot_id,
          action_ref: c.action.action_ref,
          item_id: item.item_id,
          lease_id: item.lease_id!,
          run_id: item.current_attempt_id!,
          expected_item_version: item.version,
        },
        c.preDeps
      );
      if (observed.status !== 'eligible_observed')
        throw new executor.DotExecutorPreEffectError('Judgment observation unavailable', {
          retryable: false,
        });
      if (c.kind === 'repair') {
        // No await, callback, model read or attacker-controlled path between observation and write.
        io.safeWriteFile(output, expected.bytes);
        writes.push(output);
      } else {
        if (options.fail)
          throw new executor.DotExecutorPreEffectError('Synthetic verifier refuses', {
            retryable: false,
          });
        verifierResult = verification.verifySyntheticLatencyArtifact({
          artifactBytes: String(io.safeReadFile(output, { encoding: 'utf8' })),
          expectedFileSha256: expected.file_sha256,
          expectedConfigurationHash: expected.configuration_hash,
          workerProof: proof(repair, true),
          verifierProof: proof(verifier, false),
          trustedMeasurement,
        });
        if (verifierResult.status !== 'artifact_content_verified')
          throw new Error('Independent verifier rejected actual bytes');
      }
      options.afterCheck?.();
      return {
        status: 'succeeded' as const,
        summary: 'Synthetic file port finished',
        executedSteps: 1,
      };
    });
    const row = await executor.executeDotWorkItem(
      c.charter,
      c.getItem(),
      {
        runPipeline: port,
        runGoalTurn: forbidden,
        delegateText: forbidden,
      },
      {
        rootDir: root,
        now,
        clock: Date.now,
        throttle: () => 'normal',
        tokenCapReached: () => false,
        appendInbox: inbox,
        audit: () => undefined,
      }
    );
    return { row, port };
  }
  // Controller owns parent lifecycle. A pure verifier result alone can never complete it.
  function complete() {
    try {
      const workerProof = proof(repair, true),
        verifierProof = proof(verifier, true);
      if (verifierResult?.status !== 'artifact_content_verified') return false;
      const bytes = String(io.safeReadFile(output, { encoding: 'utf8' }));
      const checked = verification.verifySyntheticLatencyArtifact({
        artifactBytes: bytes,
        expectedFileSha256: expected.file_sha256,
        expectedConfigurationHash: expected.configuration_hash,
        workerProof,
        verifierProof,
        trustedMeasurement,
      });
      if (
        checked.status !== 'artifact_content_verified' ||
        sha(bytes) !== verifierResult.artifact_sha256
      )
        return false;
      const observation = latency.createSyntheticLatencyObservation({
        scope: data.scope,
        observedAt: now().toISOString(),
        configuration: JSON.parse(bytes),
        users: 100,
      });
      if (
        observation.status !== 'ready' ||
        observation.observation.p95_ms > 500 ||
        observation.observation.load_profile_hash !== trustedMeasurement.load_profile_hash ||
        observation.observation.model_hash !== trustedMeasurement.model_hash ||
        checked.incremental_monthly_cost !== 0
      )
        return false;
      const current = coordination.getWorkItem(parent.item_id, { rootDir: root });
      if (
        !current ||
        current.version !== parent.version ||
        current.status !== 'ready' ||
        precedents.judgmentCanonicalHash(current.context) !==
          precedents.judgmentCanonicalHash(parent.context)
      )
        return false;
      coordination.updateWorkItem({
        rootDir: root,
        itemId: parent.item_id,
        expectedVersion: parent.version,
        status: 'done',
      });
      return true;
    } catch {
      return false;
    }
  }
  return {
    data,
    parent,
    output,
    expected,
    trustedMeasurement,
    repair,
    verifier,
    run,
    complete,
    proof,
    writes,
    forbidden,
    inbox,
    readParent: () => coordination.getWorkItem(parent.item_id, { rootDir: root })!,
    eventFile: () => ledger.withCoordinationRoot(root, ledger.eventsPath),
  };
}

describe('confidential executor prerequisite guard', () => {
  it('keeps ordinary charter-role result append and private body reads denied after the scoped facade is added', async () => {
    const f = await fixture();
    const { withExecutionContext } = await import('../authority.js');
    const { dotStatePath, DOT_WORK_RESULTS_FILE } = await import('./dot-state-paths.js');
    const file = path.join(root, dotStatePath(f.repair.charter, DOT_WORK_RESULTS_FILE));
    io.safeMkdir(path.dirname(file), { recursive: true });
    const bytes = JSON.stringify({ summary: 'protected ordinary reader boundary' }) + '\n';
    io.safeWriteFile(file, bytes);
    const ordinary = <T>(fn: () => T) =>
      withExecutionContext(
        f.repair.charter.authority.authority_role,
        fn,
        undefined,
        'synthetic-latency',
        'synthetic-org'
      );
    expect(() => ordinary(() => io.safeAppendFileSync(file, 'forged\n'))).toThrow();
    expect(() =>
      ordinary(() => executor.readDotWorkResults(f.repair.charter, { rootDir: root }))
    ).toThrow();
    const item = f.repair.getItem();
    expect(item.status).toBe('ready');
    expect(item.current_attempt_id).toBeUndefined();
    expect(() => f.proof(f.repair, true)).toThrow();
    expect(f.complete()).toBe(false);
    expect(f.readParent().status).toBe('ready');
    expect(f.writes).toHaveLength(0);
    expect(String(io.safeReadFile(file, { encoding: 'utf8' }))).toBe(bytes);
    expect(f.forbidden).not.toHaveBeenCalled();
    expect(f.inbox).not.toHaveBeenCalled();
  });
});

describe('synthetic latency loop through actual admission, independent claims and scoped results', () => {
  it('requires real independent verification and reobservation before the actual parent completes', async () => {
    const f = await fixture();
    const worker = await f.run(f.repair);
    expect(worker.row, JSON.stringify(worker.row)).toMatchObject({
      status: 'done',
      mode: 'pipeline',
    });
    expect(f.writes).toHaveLength(1);
    expect(f.complete()).toBe(false);
    expect(f.readParent().status).toBe('ready');
    const verified = await f.run(f.verifier);
    expect(verified.row, JSON.stringify(verified.row)).toMatchObject({
      status: 'done',
      mode: 'pipeline',
    });
    const workerProof = f.proof(f.repair, true),
      verifierProof = f.proof(f.verifier, true);
    expect(workerProof.work_ref).toBe(f.parent.item_id);
    expect(verifierProof.work_ref).toBe(f.parent.item_id);
    expect(workerProof.claim_actor_id).not.toBe(verifierProof.claim_actor_id);
    expect(f.complete()).toBe(true);
    expect(f.readParent()).toMatchObject({ status: 'done', version: f.parent.version + 1 });
    expect(f.forbidden).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
  });
  it('worker success and an invented verifier proof never complete the actual parent', async () => {
    const f = await fixture();
    expect((await f.run(f.repair)).row.status).toBe('done');
    const actual = f.proof(f.repair, true);
    const forged = {
      work_ref: actual.work_ref,
      effect_ref: 'invented-effect',
      action_ref: 'invented-action',
      operation_key: 'invented-operation',
      work_item_id: 'invented-item',
      claim_actor_id: 'dot:invented-verifier',
      lease_id: 'invented-lease',
      run_id: 'invented-run',
    };
    // The pure DTO checker deliberately cannot authenticate claims. The controller does not trust it alone.
    expect(
      verification.verifySyntheticLatencyArtifact({
        artifactBytes: f.expected.bytes,
        expectedFileSha256: f.expected.file_sha256,
        expectedConfigurationHash: f.expected.configuration_hash,
        workerProof: actual,
        verifierProof: forged,
        trustedMeasurement: f.trustedMeasurement,
      }).status
    ).toBe('artifact_content_verified');
    expect(f.verifier.getItem().attempts ?? []).toHaveLength(0);
    expect(f.complete()).toBe(false);
    expect(f.readParent().status).toBe('ready');
  });
  it.each(['expired-receipt', 'changed-source'] as const)(
    'stale %s is an actual nonretryable pre-effect failure with zero writes',
    async (condition) => {
      const f = await fixture();
      if (condition === 'expired-receipt') vi.setSystemTime(baseTime + 5 * 60_000);
      else f.repair.stale();
      const result = await f.run(f.repair);
      expect(result.port).toHaveBeenCalledTimes(1);
      expect(result.row).toMatchObject({
        status: 'failed',
        mode: 'escalated',
        reason_code: 'pre_effect_failure',
      });
      const item = f.repair.getItem();
      expect(item.status).toBe('archived');
      expect(item.lease_id).toBeUndefined();
      expect(item.metadata?.dot_executor).toMatchObject({
        reason_code: 'pre_effect_failure',
        escalated: true,
      });
      expect(item.metadata?.dot_executor).not.toHaveProperty('retryable', true);
      expect(item.effect_ownership?.state).not.toBe('held');
      expect(f.writes).toHaveLength(0);
      expect(io.safeExistsSync(f.output)).toBe(false);
      expect(f.complete()).toBe(false);
      expect(f.readParent().status).toBe('ready');
    }
  );
  it('a verifier failure leaves the parent nonterminal despite successful actual repair', async () => {
    const f = await fixture();
    expect((await f.run(f.repair)).row.status).toBe('done');
    expect((await f.run(f.verifier, { fail: true })).row).toMatchObject({
      status: 'failed',
      reason_code: 'pre_effect_failure',
    });
    expect(f.complete()).toBe(false);
    expect(f.readParent().status).toBe('ready');
    expect(f.writes).toHaveLength(1);
  });
  it.each([
    'missing',
    'malformed',
    'baseline',
    'changed-profile',
    'changed-model',
    'changed-seed',
    'worker-expected-hash',
  ] as const)(
    'independent verification refuses actual %s artifact rather than the worker summary',
    async (condition) => {
      const f = await fixture();
      expect((await f.run(f.repair)).row.status).toBe('done');
      if (condition === 'missing') io.safeRmSync(f.output);
      else if (condition === 'malformed') io.safeWriteFile(f.output, '{');
      else if (condition === 'baseline')
        io.safeWriteFile(f.output, JSON.stringify(f.data.configurations.baseline));
      else
        io.safeWriteFile(
          f.output,
          JSON.stringify({
            ...f.data.configurations.repair,
            ...(condition === 'changed-profile'
              ? { load_profile: { sample_count: 1, cohort_users: [65] } }
              : {}),
            ...(condition === 'changed-model' ? { cost_model: { repair_parallelism: 500 } } : {}),
            ...(condition === 'changed-seed' ? { seed: 1 } : {}),
            ...(condition === 'worker-expected-hash' ? { expectedFileSha256: sha('forged') } : {}),
          })
        );
      expect(Object.isFrozen(f.trustedMeasurement)).toBe(true);
      expect(Object.isFrozen(f.trustedMeasurement.load_profile)).toBe(true);
      const result = await f.run(f.verifier);
      expect(result.row.status).not.toBe('done');
      expect(f.complete()).toBe(false);
      expect(f.readParent().status).toBe('ready');
    }
  );
  it('reobserves actual bytes after verifier execution before completing the parent', async () => {
    const f = await fixture();
    await f.run(f.repair);
    expect(
      (
        await f.run(f.verifier, {
          afterCheck: () =>
            io.safeWriteFile(f.output, JSON.stringify(f.data.configurations.baseline)),
        })
      ).row.status
    ).toBe('done');
    expect(f.complete()).toBe(false);
    expect(f.readParent().status).toBe('ready');
  });
  it.each(['parent-version', 'parent-context'] as const)(
    'does not complete a changed actual %s',
    async (condition) => {
      const f = await fixture();
      await f.run(f.repair);
      await f.run(f.verifier);
      coordination.updateWorkItem({
        rootDir: root,
        itemId: f.parent.item_id,
        expectedVersion: f.parent.version,
        ...(condition === 'parent-version'
          ? { title: 'New controller revision' }
          : { context: { ...f.parent.context, task_id: 'new-task' } }),
      });
      expect(f.complete()).toBe(false);
      expect(f.readParent().status).toBe('ready');
    }
  );
  it('missing retained actual claim/completion history fails closed', async () => {
    const f = await fixture();
    await f.run(f.repair);
    await f.run(f.verifier);
    // Deliberately corrupt only this fixture namespace; no production recovery or repair is attempted.
    io.safeWriteFile(f.eventFile(), '');
    expect(f.complete()).toBe(false);
    expect(f.readParent().status).toBe('ready');
  });
  it.each(['wrong-actor', 'reused-lease', 'different-parent', 'wrong-scope'] as const)(
    'rejects corrupted retained actual %s proof',
    async (condition) => {
      const f = await fixture();
      await f.run(f.repair);
      await f.run(f.verifier);
      const verifier = f.verifier.getItem();
      const attempt = verifier.attempts!.at(-1)!;
      if (condition === 'wrong-actor') {
        ledger.withCoordinationRoot(root, () => {
          const lease = ledger
            .currentLeaseRecords()
            .find((row) => row.lease_id === attempt.lease_id)!;
          ledger.appendLeaseSnapshot({ ...lease, holder_peer_id: 'infrastructure_sentinel' });
        });
      } else {
        // An invalid store snapshot models corruption, never a legal rebinding/recovery operation.
        const corrupted = structuredClone(verifier);
        if (condition === 'reused-lease')
          corrupted.attempts!.at(-1)!.lease_id = f.proof(f.repair, true).lease_id;
        else if (condition === 'different-parent') {
          const binding = structuredClone(f.verifier.bound.semantic_judgment);
          binding.judgment_binding.work_ref = 'different-parent';
          corrupted.metadata!.semantic_judgment = binding;
        } else corrupted.context = { ...corrupted.context, project_id: 'different-project' };
        ledger.withCoordinationRoot(root, () =>
          ledger.appendItemSnapshot({ ...corrupted, version: verifier.version + 1 })
        );
      }
      expect(f.complete()).toBe(false);
      expect(f.readParent().status).toBe('ready');
    }
  );
});
