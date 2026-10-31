/**
 * Fresh generic DOT jobs with approved synthetic pipeline ports, not semantic-bound or production ADF authority.
 * The fixture controller reconstructs actual execution/measurement proof before recording `golden` telemetry;
 * that label is not API-authenticated proof. Pin delivery and worker reports alone are not verification.
 * Reuse exercises a fixed permitted operation, not model-driven learning or empirical causal improvement.
 * A first-enqueue wrapper supplies real audit evidence omitted in test mode; this is not proof of production adapter audit automation.
 */
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import type { DotCharter } from '../dot/dot-charter.js';
import type { WorkItem } from '../workforce/work-coordination-types.js';
import type { DeliveredKnowledgeRef } from '../knowledge/knowledge-feedback-loop.js';
import type { ScopeContext } from '../scope-context.js';
// Fuzzy/index searches are stubbed; the synchronous first-enqueue audit wrapper below still calls real storage.
// Actual pinned bytes, scope and publication proof are real; production automatic audit behavior is not asserted.
vi.mock('../knowledge/distill-knowledge-injector.js', async (original) => ({
  ...(await original<typeof import('../knowledge/distill-knowledge-injector.js')>()),
  findRelevantDistilledKnowledge: vi.fn(async () => []),
}));
vi.mock('./tenant-knowledge-retrieval.js', async (original) => ({
  ...(await original<typeof import('./tenant-knowledge-retrieval.js')>()),
  queryTenantKnowledgeOutcome: vi.fn(async () => ({
    status: 'empty',
    reason: 'no_match',
    hits: [],
    partial: false,
  })),
}));
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const root = path.join(sourceRoot, 'active/shared/tmp', `vitest-learning-reuse-${randomUUID()}`);
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
let bootstrap: typeof import('../secure-io.js'), io: typeof import('../secure-io.js');
let latency: typeof import('./judgment-latency-fixture.js'),
  verify: typeof import('./judgment-latency-verification.js');
let executor: typeof import('../dot/dot-executor.js'),
  dispatch: typeof import('../dot/dot-dispatch.js'),
  proposals: typeof import('../dot/dot-proposals.js');
let actions: typeof import('../dot/dot-action-ledger.js'),
  charters: typeof import('../dot/dot-charter.js'),
  workInput: typeof import('../dot/dot-work-item.js');
let coordination: typeof import('../workforce/work-coordination.js'),
  ledger: typeof import('../workforce/work-coordination-ledger.js');
let identity: typeof import('../workforce/work-coordination-identity.js'),
  json: typeof import('../foundation/json.js');
let artifacts: typeof import('../workforce/artifact-store.js'),
  feedback: typeof import('../execution-feedback-candidates.js'),
  learning: typeof import('../execution-feedback-learning.js');
let distill: typeof import('../knowledge/distill-candidate-registry.js'),
  queue: typeof import('../knowledge/memory-promotion-queue.js');
let workflow: typeof import('../knowledge/scoped-learning-workflow.js'),
  domain: typeof import('../knowledge/scoped-learning-domain.js'),
  publication: typeof import('../knowledge/scoped-learning-publication.js');
let approvals: typeof import('../governance/approval-store.js'),
  members: typeof import('./member-registry.js'),
  projects: typeof import('../project/project-registry.js');
let authority: typeof import('../authority.js'),
  reasoning: typeof import('../reasoning/reasoning-backend.js'),
  audit: typeof import('../governance/audit-chain.js');
let hints: typeof import('../mission/mission-context-pack-knowledge.js'),
  delivery: typeof import('../knowledge/knowledge-feedback-loop.js');
let snapshots: typeof import('../knowledge/knowledge-delivery-snapshot.js'),
  reuse: typeof import('../knowledge/knowledge-verification.js');
let states: typeof import('../dot/dot-state-paths.js');
let serial = 0;
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
  const policyPath = path.join(root, 'knowledge/product/governance/autonomous-ops-policy.json'),
    policy = JSON.parse(String(bootstrap.safeReadFile(policyPath, { encoding: 'utf8' })));
  policy.actions.dot_delegate_work.axis_scores = {
    scope: 0,
    reversibility: 0,
    sensitivity: 0,
    confidence: 0,
  };
  bootstrap.safeWriteFile(policyPath, JSON.stringify(policy));
  bootstrap.safeMkdir(path.join(root, 'knowledge/personal/tenants'), { recursive: true });
  for (const tenant of ['synthetic-latency', 'learning-other'])
    bootstrap.safeWriteFile(
      path.join(root, 'knowledge/personal/tenants', tenant + '.json'),
      JSON.stringify({
        tenant_slug: tenant,
        display_name: 'Isolated fixture',
        status: 'active',
        assigned_role: 'owner',
      })
    );
  bootstrap.safeWriteFile(path.join(root, 'package.json'), '{}');
  vi.stubEnv('KYBERION_ROOT', root);
  vi.stubEnv('KYBERION_PERSONA', 'sovereign');
  vi.stubEnv('MISSION_ROLE', 'mission_controller');
  vi.stubEnv('SYSTEM_ROLE', 'operator_surface');
  vi.stubEnv('KYBERION_TENANT', 'synthetic-latency');
  vi.stubEnv('KYBERION_REASONING_BACKEND', 'stub');
  vi.stubEnv('KYBERION_NHI_ACTOR', 'warn');
  vi.resetModules();
  io = await import('../secure-io.js');
  latency = await import('./judgment-latency-fixture.js');
  verify = await import('./judgment-latency-verification.js');
  executor = await import('../dot/dot-executor.js');
  dispatch = await import('../dot/dot-dispatch.js');
  proposals = await import('../dot/dot-proposals.js');
  actions = await import('../dot/dot-action-ledger.js');
  charters = await import('../dot/dot-charter.js');
  workInput = await import('../dot/dot-work-item.js');
  coordination = await import('../workforce/work-coordination.js');
  ledger = await import('../workforce/work-coordination-ledger.js');
  identity = await import('../workforce/work-coordination-identity.js');
  json = await import('../foundation/json.js');
  artifacts = await import('../workforce/artifact-store.js');
  feedback = await import('../execution-feedback-candidates.js');
  learning = await import('../execution-feedback-learning.js');
  distill = await import('../knowledge/distill-candidate-registry.js');
  queue = await import('../knowledge/memory-promotion-queue.js');
  workflow = await import('../knowledge/scoped-learning-workflow.js');
  domain = await import('../knowledge/scoped-learning-domain.js');
  publication = await import('../knowledge/scoped-learning-publication.js');
  approvals = await import('../governance/approval-store.js');
  members = await import('./member-registry.js');
  projects = await import('../project/project-registry.js');
  authority = await import('../authority.js');
  reasoning = await import('../reasoning/reasoning-backend.js');
  audit = await import('../governance/audit-chain.js');
  hints = await import('../mission/mission-context-pack-knowledge.js');
  delivery = await import('../knowledge/knowledge-feedback-loop.js');
  snapshots = await import('../knowledge/knowledge-delivery-snapshot.js');
  reuse = await import('../knowledge/knowledge-verification.js');
  states = await import('../dot/dot-state-paths.js');
  projects.saveProjectRecord({
    project_id: 'synthetic-project',
    name: 'Synthetic measurement',
    summary: 'Learning reuse',
    status: 'active',
    tier: 'confidential',
    tenant_slug: 'synthetic-latency',
    organization_id: 'synthetic-org',
  } as Parameters<typeof projects.saveProjectRecord>[0]);
});
afterEach(() => {
  vi.restoreAllMocks();
  reasoning?.resetReasoningBackend();
  coordination?.clearWorkCoordinationNamespace();
  if (states && latency)
    io.safeRmSync(
      path.join(
        root,
        states.dotStatePath(
          { scope: latency.createJudgmentLatencyFixture().scope },
          states.DOT_WORK_RESULTS_FILE
        )
      ),
      { force: true }
    );
});
afterAll(() => {
  vi.unstubAllEnvs();
  bootstrap?.safeRmSync(root, { recursive: true, force: true });
  vi.resetModules();
});

async function fixture() {
  const id = 'reuse-' + ++serial,
    data = latency.createJudgmentLatencyFixture(),
    scope = data.scope;
  coordination.setWorkCoordinationNamespace(id);
  reasoning.registerReasoningBackend(reasoning.stubReasoningBackend);
  const directory = path.join(root, 'active/shared/tmp', id),
    output = path.join(directory, 'worker-configuration.json');
  io.safeMkdir(directory, { recursive: true });
  const expected = verify.syntheticLatencyArtifactBytes(data.configurations.repair);
  if (expected.status !== 'ready') throw new Error('Unknown fixed configuration');
  const baseline = verify.syntheticLatencyArtifactBytes(data.configurations.baseline);
  if (baseline.status !== 'ready') throw new Error('Unknown baseline');
  io.safeWriteFile(output, baseline.bytes);
  const contract = latency.syntheticLatencyMeasurementContract();
  const now = () => new Date();
  const forbidden = vi.fn(async (): Promise<never> => {
    throw new Error('No model/delegation calls permitted');
  });
  const inbox = vi.fn();
  const executorDeps = {
    rootDir: root,
    now,
    clock: Date.now,
    throttle: () => 'normal' as const,
    tokenCapReached: () => false,
    appendInbox: inbox,
    audit: () => undefined,
  };
  function observe() {
    const bytes = String(io.safeReadFile(output, { encoding: 'utf8' })),
      configuration = JSON.parse(bytes);
    const sixtyFive = latency.measureSyntheticLatency(configuration, 65),
      hundred = latency.measureSyntheticLatency(configuration, 100);
    if (
      sixtyFive.status !== 'measured' ||
      hundred.status !== 'measured' ||
      sixtyFive.model_hash !== contract.model_hash ||
      hundred.load_profile_hash !== contract.load_profile_hash
    )
      throw new Error('Independent fixed-condition measurement unavailable');
    return {
      bytes_sha256: sha(bytes),
      configuration_hash: hundred.configuration_hash,
      model_hash: contract.model_hash,
      load_profile_hash: contract.load_profile_hash,
      seed: contract.load_profile.seed,
      users65_p95: sixtyFive.p95_ms,
      users100_p95: hundred.p95_ms,
      users: [65, 100],
      incremental_monthly_jpy: 0,
      meets_goals: hundred.p95_ms <= 500 && sixtyFive.p95_ms <= 500,
    };
  }
  async function job(kind: string) {
    const dotId = `${id}-${kind}`;
    const charter: DotCharter = {
      ...structuredClone(data.charter),
      dot_id: dotId,
      attention: { triggers: [{ kind: 'cron', cron: '*/15 * * * *' }] },
      authority: {
        ...data.charter.authority,
        authority_role: 'infrastructure_sentinel',
        max_concurrent_delegations: 4,
      },
      runtime: { heartbeat_id: dotId },
    };
    const charterPath = path.join(
      root,
      'knowledge/confidential/synthetic-latency/dots',
      dotId + '.json'
    );
    io.safeMkdir(path.dirname(charterPath), { recursive: true });
    io.safeWriteFile(charterPath, JSON.stringify(charter));
    const proposal = proposals.normalizeDotProposal({
      title: 'Independent synthetic ' + kind,
      objective: 'Preserve 100 users, 500 ms and zero added JPY',
      work_shape: 'pipeline',
      pipeline_ref: latency.SYNTHETIC_LATENCY_PIPELINE_REF,
      target: 'service:' + id,
      intent: 'apply',
    });
    const action = dispatch.dispatchDotProposals(charter, [proposal], {
      rootDir: root,
      operationKey: dotId,
      now,
      feedback: { onRejection: vi.fn() },
    }).records[0];
    expect(action.status).toBe('dispatched');
    const item = () => coordination.getWorkItem(action.work_item_id!, { rootDir: root })!;
    async function run(port: () => void) {
      const pipeline = vi.fn(async (_ref: string, context: Record<string, unknown>) => {
        const current = item();
        if (
          context.work_item_id !== current.item_id ||
          context.attempt_id !== current.current_attempt_id ||
          context.lease_id !== current.lease_id
        )
          throw new executor.DotExecutorPreEffectError('Actual execution identity differs', {
            retryable: false,
          });
        port();
        return {
          status: 'succeeded' as const,
          summary: 'Synthetic ' + kind + ' completed',
          executedSteps: 1,
        };
      });
      const result = await executor.executeDotWorkItem(
        charter,
        item(),
        { runPipeline: pipeline, runGoalTurn: forbidden, delegateText: forbidden },
        executorDeps
      );
      return { result, pipeline };
    }
    function proof() {
      const actual = actions
          .currentDotActions(dotId, { rootDir: root })
          .find((row) => row.action_ref === action.action_ref)!,
        current = item(),
        attempt = current.attempts?.at(-1);
      actions.assertDotActionJudgmentBinding(actual);
      const canonical = charters.findDotCharter(dotId, root)?.charter;
      if (
        !canonical ||
        JSON.stringify(canonical) !== JSON.stringify(charter) ||
        actual.work_item_id !== current.item_id ||
        actual.actor_id !== 'dot:' + dotId ||
        current.context?.tenant_slug !== scope.tenant_slug ||
        current.context.organization_id !== scope.organization_id ||
        current.context.project_id !== scope.project_id ||
        current.status !== 'done' ||
        !attempt ||
        attempt.status !== 'released' ||
        attempt.actor_peer_id !== 'dot:' + dotId ||
        current.effect_ownership?.state !== 'settled' ||
        current.effect_ownership.settlement !== 'completed' ||
        current.effect_ownership.attempt_id !== attempt.run_id
      )
        throw new Error('Actual completed worker evidence differs');
      const history = ledger.withCoordinationRoot(root, () =>
        json
          .readJsonLines<WorkItem>(ledger.itemsPath())
          .filter((row) => row.item_id === current.item_id)
      );
      history.forEach(identity.validateWorkItem);
      identity.assertOriginalWorkItemIdentity(
        history,
        identity.buildWorkItemCreation(workInput.dotWorkItemInput(charter, actual, root))
      );
      const lease = ledger.withCoordinationRoot(root, () =>
        ledger.currentLeaseRecords().find((row) => row.lease_id === attempt.lease_id)
      );
      const events = ledger.withCoordinationRoot(root, () =>
        coordination.listCoordinationEvents({ item_id: current.item_id })
      );
      if (
        !lease ||
        lease.status !== 'released' ||
        lease.holder_peer_id !== attempt.actor_peer_id ||
        lease.holder_user_id !== attempt.actor_user_id ||
        !events.some(
          (event) =>
            event.event_type === 'item_claimed' &&
            event.lease_id === lease.lease_id &&
            event.actor_peer_id === attempt.actor_peer_id
        ) ||
        !events.some(
          (event) =>
            event.event_type === 'item_attempt_released' &&
            event.payload?.run_id === attempt.run_id &&
            event.payload?.lease_id === lease.lease_id
        ) ||
        !executor
          .readDotWorkResults(charter, { rootDir: root })
          .some(
            (row) =>
              row.status === 'done' &&
              row.attempt_id === attempt.run_id &&
              row.action_ref === actual.action_ref
          )
      )
        throw new Error('Durable actual claim/result missing');
      return {
        dot_id: dotId,
        action_ref: actual.action_ref,
        operation_key: actual.admission!.operation_key!,
        work_item_id: current.item_id,
        run_id: attempt.run_id,
        lease_id: lease.lease_id,
        claim_actor_id: lease.holder_peer_id,
      };
    }
    return { charter, charterPath, action, item, run, proof };
  }
  const worker = await job('initial-worker'),
    verifier = await job('independent-verifier');
  const before = observe();
  let independent: ReturnType<typeof observe> | undefined;
  async function executeInitial(improve = true) {
    const result = await worker.run(() =>
      io.safeWriteFile(output, improve ? expected.bytes : baseline.bytes)
    );
    expect(result.result.status).toBe('done');
    const observed = await verifier.run(() => {
      independent = observe();
    });
    expect(observed.result.status).toBe('done');
    const workerProof = worker.proof(),
      verifierProof = verifier.proof();
    expect(workerProof.claim_actor_id).not.toBe(verifierProof.claim_actor_id);
    expect(workerProof.run_id).not.toBe(verifierProof.run_id);
    if (!independent) throw new Error('No independent observation');
    return {
      before,
      after: independent,
      worker: workerProof,
      verifier: verifierProof,
      contract,
      goal: { users: 100, max_p95_ms: 500, max_added_jpy: 0 },
    };
  }
  async function publishLesson(measured: Awaited<ReturnType<typeof executeInitial>>) {
    if (
      !measured.after.meets_goals ||
      measured.after.users100_p95 >= measured.before.users100_p95 ||
      measured.after.bytes_sha256 !== expected.file_sha256
    )
      return { status: 'unmet' as const };
    const evidence = artifacts.writeScopedArtifact({
      scope: {
        tenant: scope.tenant_slug,
        organization: scope.organization_id,
        project: scope.project_id,
      },
      tier: 'confidential',
      artifact_class: 'evidence',
      name: id + '-independent-measurement.json',
      create_only: true,
      content: measured,
    });
    const evidenceBytes = String(io.safeReadFile(evidence.absolute_path, { encoding: 'utf8' })),
      evidenceSha = sha(evidenceBytes);
    const source = distill.createDistillCandidateRecord({
      candidate_id: 'FEEDBACK-' + id,
      source_type: 'artifact',
      artifact_ids: [evidence.repo_relative_path],
      tier: 'confidential',
      scope,
      title: 'Bounded parallel measurement procedure',
      summary:
        'Preserve 100 users, p95 at most 500 ms, fixed profile and zero added monthly JPY during bounded parallel repair.',
      target_kind: 'sop_candidate',
      status: 'proposed',
      evidence_refs: [evidence.repo_relative_path],
      metadata: {
        improvement_kind: 'execution_feedback',
        measurement_sha256: evidenceSha,
        worker_run_id: measured.worker.run_id,
        verifier_run_id: measured.verifier.run_id,
      },
    });
    feedback.saveExecutionFeedbackCandidate(source);
    const originalEnqueue = queue.enqueueMemoryPromotionCandidate;
    const enqueue = vi
      .spyOn(queue, 'enqueueMemoryPromotionCandidate')
      .mockImplementation((candidate) => {
        const event = audit.auditChain.record({
          agentId: 'fixture-learning-controller',
          action: 'knowledge_promotion_candidate',
          operation: 'enqueue',
          result: 'completed',
          tenantSlug: scope.tenant_slug,
          correlationId: candidate.candidate_id,
        });
        const persisted = originalEnqueue({ ...candidate, audit_ref: 'audit:' + event.id });
        expect(audit.auditChain.loadAll().find((entry) => entry.id === event.id)).toMatchObject({
          id: event.id,
          tenantSlug: scope.tenant_slug,
          correlationId: candidate.candidate_id,
        });
        return persisted;
      });
    let queued: ReturnType<typeof learning.queueExecutionFeedbackLearning>;
    try {
      queued = learning.queueExecutionFeedbackLearning(source.candidate_id, scope);
    } finally {
      enqueue.mockRestore();
    }
    if (!queued.queue.candidate_id) throw new Error('Actual execution feedback was not queued');
    const candidateId = queued.queue.candidate_id,
      address = { candidateId, scope },
      current = () => queue.loadMemoryPromotionCandidate(candidateId, scope)!;
    expect(current().audit_ref).toMatch(/^audit:/);
    expect(current().status).toBe('queued');
    expect(current().learning_publication).toBeUndefined();
    const content = `Use bounded_parallel_v1. Retain 100 users, p95 <=500 ms, added JPY=0; verify both 65/100 users with the fixed seed/profile/model. Evidence SHA256 ${evidenceSha}.`;
    const curation = {
      title: 'Bounded parallel measurement procedure',
      summary: current().summary,
      content,
      evidence_refs: current().evidence_refs,
    };
    workflow.curateScopedLearningCandidate({
      ...address,
      curation,
      expectedPayloadDigest: domain.approvedLearningPayloadDigest(current()),
    });
    const review = workflow.requestScopedLearningCandidateApproval({
      ...address,
      expectedPayloadDigest: domain.approvedLearningPayloadDigest(current()),
      requester: {
        requestedBy: 'agent:fixture-learning-controller',
        actorId: 'agent:fixture-learning-controller',
      },
    });
    const ref = review.learning.approvalRef;
    if (!ref) throw new Error('Human review missing');
    const member = 'reviewer-' + id;
    authority.withExecutionContext('sovereign_concierge', () =>
      members.writeMemberProfile({
        member_id: member,
        display_name: 'Isolated fixture reviewer',
        status: 'active',
        memberships: [{ tenant_slug: scope.tenant_slug!, role: 'owner' }],
        access_registrations: [],
        created_at: now().toISOString(),
        updated_at: now().toISOString(),
      })
    );
    const requestId = ref.split(':')[1]!,
      pending = approvals.loadApprovalRequest('terminal', requestId)!;
    approvals.decideApprovalRequest('infrastructure_sentinel', {
      channel: 'terminal',
      requestId,
      decision: 'approved',
      decidedBy: 'user:' + member,
      decidedByType: 'human',
      authenticated: true,
      authMethod: 'surface_session',
      deciderIdentitySource: 'server_resolved',
      presentedDigest: approvals.computeApprovalPresentedDigest(pending),
      deciderPrincipal: {
        actor: { kind: 'human', id: 'user:' + member },
        provider: 'offline-fixture',
        source: 'oidc',
        principalId: 'user:' + member,
      },
    });
    const published = await workflow.publishScopedLearningCandidate({
      ...address,
      expectedPayloadDigest: domain.approvedLearningPayloadDigest(current()),
      executionRole: 'mission_controller',
    });
    const proof = publication.verifyScopedLearningPublication(current());
    if (published.learning.state !== 'published' || !proof)
      throw new Error('Actual publication did not verify');
    const slices = path.join(directory, 'knowledge-slices.json');
    io.safeWriteFile(
      slices,
      JSON.stringify({
        version: '0.1.0',
        slices: [
          {
            id: 'published-lesson',
            match: { team_role: 'implementer', phase: 'execution' },
            pinned: [proof.markdown_path],
          },
        ],
      })
    );
    async function deliver(work: WorkItem, recipient: ScopeContext = scope) {
      // Read-only fixture mission metadata selects the real pin loader; it is not a mission lifecycle claim.
      const missionState = {
        mission_id: 'MSN-FIXTURE-' + id,
        mission_type: 'product_development',
        tier: recipient.tier,
        tenant_slug: recipient.tenant_slug,
        status: 'active',
        assigned_persona: 'worker',
        git: {
          branch: 'fixture',
          start_commit: 'fixture',
          latest_commit: 'fixture',
          checkpoints: [],
        },
        history: [],
        ...(recipient.project_id
          ? {
              relationships: {
                project: {
                  project_id: recipient.project_id,
                  organization_id: recipient.organization_id,
                },
              },
            }
          : {}),
      };
      const loaded = await hints.loadKnowledgeHintsIfPossible({
        missionState,
        teamRole: 'implementer',
        phase: 'execution',
        workItem: work,
        knowledgeSlicesPath: slices,
        tenantKnowledgeRootDir: root,
      });
      if (
        recipient === scope &&
        sha(String(io.safeReadFile(path.join(root, proof.markdown_path), { encoding: 'utf8' }))) ===
          proof.markdown_sha256
      ) {
        const sliceApi = await import('../knowledge/knowledge-slices.js');
        expect(hints.organizationIdFromContext({ missionState })).toBe(scope.organization_id);
        // The path-guard fix validates ancestors without granting metadata access to the tenantless prefix.
        expect(() => io.safeLstat(path.join(root, 'knowledge/confidential'))).toThrow(
          /ROLE_VIOLATION.*tenant.scope_invalid_prefix/
        );
        expect(io.safeLstat(path.join(root, proof.markdown_path)).isFile()).toBe(true);
        const textApi = await import('../foundation/text.js');
        expect(
          sha(textApi.readTextFile(path.join(root, proof.markdown_path))),
          'actual governed text read'
        ).toBe(proof.markdown_sha256);
        expect(
          sliceApi.resolveKnowledgeSlice({
            teamRole: 'implementer',
            phase: 'execution',
            missionType: 'product_development',
            tenant: scope.tenant_slug,
            project: scope.project_id,
            slicesPath: slices,
          }).pinned,
          'actual manifest resolution'
        ).toContain(proof.markdown_path);
        const raw = String(
          io.safeReadFile(path.join(root, proof.markdown_path), { encoding: 'utf8' })
        );
        const frontmatter = raw.slice(4, raw.indexOf('\n---\n', 4));
        const retrieval = await import('../knowledge/scoped-learning-retrieval.js');
        expect(
          retrieval.resolveScopedLearningRetrieval({
            documentPath: proof.markdown_path,
            sourceSha256: sha(raw),
            candidateId: frontmatter
              .match(/^candidate_id:\s*(.+)$/m)?.[1]
              ?.trim()
              .replace(/^["']|["']$/g, ''),
            scopeText: frontmatter.match(/^scope:\s*(.+)$/m)?.[1]?.trim(),
            consumerScope: { ...scope, mission_id: missionState.mission_id, task_id: work.item_id },
          }),
          'actual same-byte publication retrieval'
        ).toMatchObject({ governed: true, publication: proof });
        const compiler = await import('../context-security-scope.js');
        const fragment = hints.knowledgeHintFragment(
          {
            path: proof.markdown_path,
            title: 'Bounded parallel measurement procedure',
            excerpt: 'same-byte diagnostic',
            source_sha256: proof.markdown_sha256,
            learning_publication: proof,
          },
          0
        );
        expect(
          compiler.compileScopedContextPack(
            {
              ...scope,
              tenant_slug: scope.tenant_slug!,
              read_tiers: ['public', 'confidential'],
              write_tier: 'confidential',
              mission_id: missionState.mission_id,
              task_id: work.item_id,
              purpose: 'implementer',
            },
            [fragment]
          ).fragments,
          'actual scope compiler'
        ).toHaveLength(1);
      }
      const lesson = loaded.find((hint) => hint.path === proof.markdown_path);
      if (!lesson) return [];
      const snapshot = snapshots.createKnowledgeDeliverySnapshot({
        text: lesson.excerpt,
        form: 'context_string',
        source_sha256: lesson.source_sha256,
        learning_publication: lesson.learning_publication,
      });
      return (
        delivery.recordKnowledgeDelivery({
          missionId: missionState.mission_id,
          taskId: work.item_id,
          teamRole: 'implementer',
          recipientKind: 'synthetic_pipeline',
          scope: recipient,
          refs: [{ path: lesson.path, title: lesson.title, snapshot }],
        })?.refs ?? []
      );
    }
    const summary = () =>
      reuse.inspectKnowledgeReuse({
        documentPath: proof.markdown_path,
        sourceSha256: proof.markdown_sha256,
        scope,
      });
    return {
      status: 'published' as const,
      evidence,
      evidenceSha,
      current,
      proof,
      deliver,
      summary,
    };
  }
  return {
    id,
    data,
    scope,
    worker,
    verifier,
    job,
    observe,
    executeInitial,
    publishLesson,
    output,
    expected,
    baseline,
    forbidden,
  };
}

describe('measured scoped lesson publication and next-work reuse', () => {
  it('binds fresh real execution evidence to human-reviewed publication, pinned delivery and independently verified next work', async () => {
    const f = await fixture(),
      measured = await f.executeInitial(),
      lesson = await f.publishLesson(measured);
    expect(measured.before).toMatchObject({ users65_p95: 1800, users100_p95: 2500 });
    expect(measured.after).toMatchObject({
      users65_p95: 360,
      users100_p95: 500,
      incremental_monthly_jpy: 0,
    });
    expect(lesson.status).toBe('published');
    if (lesson.status !== 'published') throw new Error('Expected actual lesson');
    expect(lesson.summary().verified_successes).toBe(0);
    const next = await f.job('next-worker'),
      refs = await lesson.deliver(next.item());
    expect(refs).toHaveLength(1);
    expect(refs[0].snapshot?.source_sha256).toBe(lesson.proof.markdown_sha256);
    expect(refs[0].snapshot?.learning_publication).toEqual(lesson.proof);
    expect(lesson.summary()).toMatchObject({ deliveries: 1, verified_successes: 0 });
    io.safeWriteFile(f.output, f.baseline.bytes);
    const result = await next.run(() => {
      if (
        !refs[0].snapshot ||
        refs[0].snapshot.source_sha256 !== lesson.proof.markdown_sha256 ||
        sha(String(io.safeReadFile(lesson.evidence.absolute_path, { encoding: 'utf8' }))) !==
          lesson.evidenceSha
      )
        throw new executor.DotExecutorPreEffectError('Pinned evidence differs', {
          retryable: false,
        });
      io.safeWriteFile(f.output, f.expected.bytes);
    });
    expect(result.result.status).toBe('done');
    const nextProof = next.proof();
    const usage = delivery.recordKnowledgeUsageFeedback({
      missionId: 'MSN-FIXTURE-' + f.id,
      taskId: next.item().item_id,
      scope: f.scope,
      deliveredRefs: refs,
      resultId: nextProof.run_id,
      outcome: 'worker_report_complete',
      feedback: { used: [lesson.proof.markdown_path] },
    });
    expect(usage.usageUpdated).toBe(true);
    expect(lesson.summary().verified_successes).toBe(0);
    const check = await f.job('next-independent-verifier');
    let observed: ReturnType<typeof f.observe> | undefined;
    expect(
      (
        await check.run(() => {
          observed = f.observe();
        })
      ).result.status
    ).toBe('done');
    const checkProof = check.proof();
    expect(checkProof.claim_actor_id).not.toBe(nextProof.claim_actor_id);
    expect(observed?.meets_goals).toBe(true);
    expect(observed?.bytes_sha256).toBe(f.expected.file_sha256);
    reuse.recordKnowledgeVerifiedRun({
      documentSnapshots: refs,
      receiptId: sha(JSON.stringify({ nextProof, checkProof, observed })),
      scope: f.scope,
      evidence: 'golden',
    });
    expect(lesson.summary()).toMatchObject({
      deliveries: 1,
      worker_reported_successes: 1,
      verified_successes: 1,
      state: 'verified',
    });
    expect(f.forbidden).not.toHaveBeenCalled();
  });
  it('successful worker and measurement jobs do not queue a lesson when original metrics did not improve', async () => {
    const f = await fixture(),
      measured = await f.executeInitial(false);
    const before = queue
      .listMemoryPromotionCandidates(f.scope)
      .map((candidate) => candidate.candidate_id);
    expect(measured.after.meets_goals).toBe(false);
    expect((await f.publishLesson(measured)).status).toBe('unmet');
    expect(
      queue.listMemoryPromotionCandidates(f.scope).map((candidate) => candidate.candidate_id)
    ).toEqual(before);
    expect(f.worker.item().status).toBe('done');
  });
  it('delivery alone and worker self-report alone cannot become independently verified improvement', async () => {
    const f = await fixture(),
      lesson = await f.publishLesson(await f.executeInitial());
    if (lesson.status !== 'published') throw new Error('Missing lesson');
    const next = await f.job('unchanged-next'),
      refs = await lesson.deliver(next.item());
    expect(lesson.summary()).toMatchObject({ deliveries: 1, verified_successes: 0 });
    io.safeWriteFile(f.output, f.baseline.bytes);
    expect((await next.run(() => io.safeWriteFile(f.output, f.baseline.bytes))).result.status).toBe(
      'done'
    );
    const proof = next.proof();
    delivery.recordKnowledgeUsageFeedback({
      missionId: 'MSN-FIXTURE-' + f.id,
      taskId: next.item().item_id,
      scope: f.scope,
      deliveredRefs: refs,
      resultId: proof.run_id,
      outcome: 'worker_report_complete',
      feedback: { used: [lesson.proof.markdown_path] },
    });
    expect(f.observe().meets_goals).toBe(false);
    expect(lesson.summary()).toMatchObject({ worker_reported_successes: 1, verified_successes: 0 });
  });
  it('the same immutable pin is not delivered across tenant or sibling-project scope', async () => {
    const f = await fixture(),
      lesson = await f.publishLesson(await f.executeInitial());
    if (lesson.status !== 'published') throw new Error('Missing lesson');
    const next = await f.job('scope-receiver');
    expect(
      await lesson.deliver(next.item(), { ...f.scope, tenant_slug: 'learning-other' })
    ).toEqual([]);
    const sibling = {
      ...next.item(),
      project_id: 'other-project',
      context: { ...next.item().context, project_id: 'other-project' },
    };
    expect(await lesson.deliver(sibling, { ...f.scope, project_id: 'other-project' })).toEqual([]);
    expect(lesson.summary()).toMatchObject({ deliveries: 0, verified_successes: 0 });
    expect(next.item().status).toBe('ready');
  });
  it('changed published bytes cannot be passed off as the pinned reviewed lesson', async () => {
    const f = await fixture(),
      lesson = await f.publishLesson(await f.executeInitial());
    if (lesson.status !== 'published') throw new Error('Missing lesson');
    const next = await f.job('changed-lesson');
    io.safeWriteFile(path.join(root, lesson.proof.markdown_path), 'Unreviewed replacement');
    expect(await lesson.deliver(next.item())).toEqual([]);
    expect(lesson.summary().verified_successes).toBe(0);
    expect(next.item().status).toBe('ready');
  });
});
