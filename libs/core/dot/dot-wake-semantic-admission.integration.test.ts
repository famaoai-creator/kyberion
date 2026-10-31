/** Real admission/store noninterference under a synthetic-only auto policy, not shipped authority. */
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { DotCharter } from './dot-charter.js';
import type { DotRuntimeDeps } from './dot-runtime.js';
import type { DotSemanticJudgmentDeps, DotSemanticBudgetOwner } from './dot-semantic-judgment.js';

const notifications = vi.hoisted(() => ({ notify: vi.fn(() => true) }));
vi.mock('../surface/operator-notifications.js', async (original) => ({
  ...(await original<typeof import('../surface/operator-notifications.js')>()),
  notifyOperatorSync: notifications.notify,
}));

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const root = path.join(
  sourceRoot,
  'active/shared/tmp',
  `vitest-real-shadow-admission-${randomUUID()}`
);
let io: typeof import('../secure-io.js');
let bootstrapIo: typeof import('../secure-io.js');
let runtime: typeof import('./dot-runtime.js');
let dispatch: typeof import('./dot-dispatch.js');
let actions: typeof import('./dot-action-ledger.js');
let identities: typeof import('./dot-admission-identity.js');
let coordination: typeof import('../workforce/work-coordination.js');
let approvals: typeof import('../governance/approval-store.js');
let inbox: typeof import('./dot-inbox.js');
let json: typeof import('../foundation/json.js');
let latency: typeof import('../organization/judgment-latency-fixture.js');
let precedents: typeof import('../organization/judgment-precedents.js');
let validation: typeof import('../organization/judgment-validation.js');
let semantic: typeof import('../organization/semantic-judgment.js');
let evidence: typeof import('../organization/judgment-evidence.js');
let serial = 0;
type Scenario = 'off' | 'success' | 'persist_failure' | 'timeout';

beforeAll(async () => {
  io = await import('../secure-io.js');
  bootstrapIo = io;
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
  copy(
    path.join(sourceRoot, 'knowledge/product/governance'),
    path.join(root, 'knowledge/product/governance')
  );
  copy(
    path.join(sourceRoot, 'knowledge/product/orchestration'),
    path.join(root, 'knowledge/product/orchestration')
  );
  // This isolated fixture changes only action cost scores, not production policy or grants.
  // Actual evaluateDotProposalGate/route/store run below; the approve charter floor still wins.
  const policyPath = path.join(root, 'knowledge/product/governance/autonomous-ops-policy.json');
  const policy = JSON.parse(io.safeReadFile(policyPath, { encoding: 'utf8' }) as string);
  policy.actions.dot_delegate_work.axis_scores = {
    scope: 0,
    reversibility: 0,
    sensitivity: 0,
    confidence: 0,
  };
  io.safeWriteFile(policyPath, JSON.stringify(policy));
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
  io.safeWriteFile(path.join(root, 'package.json'), '{}');
  vi.stubEnv('KYBERION_ROOT', root);
  vi.stubEnv('KYBERION_PERSONA', 'sovereign');
  vi.stubEnv('MISSION_ROLE', 'mission_controller');
  vi.stubEnv('KYBERION_TENANT', 'synthetic-latency');
  vi.resetModules();
  io = await import('../secure-io.js');
  const { saveProjectRecord } = await import('../project/project-registry.js');
  saveProjectRecord({
    project_id: 'synthetic-project',
    name: 'Fixture',
    summary: 'Offline shadow admission',
    status: 'active',
    tier: 'confidential',
    tenant_slug: 'synthetic-latency',
    organization_id: 'synthetic-org',
  } as Parameters<typeof saveProjectRecord>[0]);
  runtime = await import('./dot-runtime.js');
  dispatch = await import('./dot-dispatch.js');
  actions = await import('./dot-action-ledger.js');
  identities = await import('./dot-admission-identity.js');
  coordination = await import('../workforce/work-coordination.js');
  approvals = await import('../governance/approval-store.js');
  inbox = await import('./dot-inbox.js');
  json = await import('../foundation/json.js');
  latency = await import('../organization/judgment-latency-fixture.js');
  precedents = await import('../organization/judgment-precedents.js');
  validation = await import('../organization/judgment-validation.js');
  semantic = await import('../organization/semantic-judgment.js');
  evidence = await import('../organization/judgment-evidence.js');
});
afterEach(() => {
  vi.restoreAllMocks();
  coordination.clearWorkCoordinationNamespace();
});
afterAll(() => {
  vi.unstubAllEnvs();
  bootstrapIo?.safeRmSync(root, { recursive: true, force: true });
  vi.resetModules();
});

async function scenario(entry: 'fence' | 'tool', kind: Scenario, approveFloor: boolean) {
  const data = latency.createJudgmentLatencyFixture();
  const id = `actual-shadow-${++serial}`;
  coordination.setWorkCoordinationNamespace(id);
  const modelConfig = {
    provider: 'fixture-provider',
    model: 'fixture-model',
    maxOutputTokens: 128,
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
  if (snapshot.status !== 'ready') throw new Error('Expected fixture snapshot');
  const proposalFacts = latency.resolveSyntheticLatencyProposal('repair_fixture');
  if (proposalFacts.status !== 'ready') throw new Error('Expected fixture facts');
  const modelInput = validation.buildJudgmentModelInput(snapshot.snapshot, proposalFacts.facts, [
    { evidence_key: 'synthetic-observation', text: data.untrusted_report.text },
  ]);
  const binding = {
    schema_version: '1' as const,
    work_ref: id,
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
  const request = {
    context: {
      binding,
      scope: data.scope,
      modelInput,
      snapshot: snapshot.snapshot,
      requiredGoalKeys: [data.goal.goal_key],
      knownProposalKeys: ['repair_fixture'],
    },
    effectRef: `effect-${id}`,
    modelConfig,
  };
  const proposal = {
    action_id: 'dot_delegate_work',
    title: 'Synthetic latency repair',
    objective: 'Prepare only the isolated synthetic fixture repair',
    work_shape: 'pipeline' as const,
    pipeline_ref: latency.SYNTHETIC_LATENCY_PIPELINE_REF,
  };
  const charter: DotCharter = {
    ...structuredClone(data.charter),
    dot_id: id,
    title: 'Actual shadow admission fixture',
    attention: { triggers: [{ kind: 'cron', cron: '*/15 * * * *' }] },
    goal: {
      statement: data.charter.goal.statement,
      budget: { wall_clock_ms_per_wake: 20_000, token_cap_per_day: 100_000 },
    },
    authority: { ...data.charter.authority, authority_role: 'infrastructure_sentinel' },
    ...(approveFloor ? { decisions: { default_decision: 'approve' as const } } : {}),
    runtime: { heartbeat_id: id, semantic_judgment: { mode: kind === 'off' ? 'off' : 'shadow' } },
  };
  const charterPath = path.join(root, 'active/shared/tmp/fixture-charters', `${id}.json`);
  io.safeMkdir(path.dirname(charterPath), { recursive: true });
  io.safeWriteFile(charterPath, JSON.stringify(charter));
  const loaded = { path: charterPath, charter: structuredClone(charter) };
  const operationKey = 'synthetic-original-wake';
  const notificationStart = notifications.notify.mock.calls.length;
  let time = Date.parse(latency.SYNTHETIC_LATENCY_NOW),
    timerId = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const advance = (ms: number) => {
    time += ms;
    for (const [key, timer] of timers)
      if (timer.at <= time) {
        timers.delete(key);
        timer.run();
      }
  };
  const inspectBusiness = () => ({
    actions: structuredClone(actions.currentDotActions(id, { rootDir: root })),
    items: structuredClone(
      coordination.listWorkItems({}).filter((item) => item.metadata?.dot_id === id)
    ),
    approvals: structuredClone(
      approvals.listApprovalRequests({}).filter((record) => record.source?.agentId === `dot:${id}`)
    ),
    inbox: json
      .readJsonLines<Record<string, unknown>>(path.join(root, inbox.dotInboxPath(data.scope)))
      .filter((row) => row.dot_id === id),
    notifications: notifications.notify.mock.calls.length - notificationStart,
  });
  let beforeObserver: ReturnType<typeof inspectBusiness> | undefined;
  const handles = new Map<object, DotSemanticBudgetOwner>();
  const observer: DotSemanticJudgmentDeps = {
    schedule: (run, delay) => {
      const key = ++timerId;
      timers.set(key, { at: time + delay, run });
      return () => {
        timers.delete(key);
      };
    },
    canEvaluate: () => true,
    prepare: vi.fn(() => {
      beforeObserver = inspectBusiness();
      return {
        request,
        requested_total_tokens: 200,
        readCurrentContext: () => ({ expectedBinding: binding, currentSnapshot: snapshot }),
      };
    }),
    budget: {
      mode: 'offline_fixture',
      reserve: ({ parent, max_tokens }) => {
        const handle = {};
        handles.set(handle, structuredClone(parent));
        return {
          status: 'reserved',
          handle,
          owner: structuredClone(parent),
          token_allowance: max_tokens,
        };
      },
      holdUnknown: (handle, parent) => {
        expect(handles.get(handle)).toEqual(parent);
        return { status: 'held_unknown' };
      },
      settle: (handle, parent, usage) => {
        expect(handles.get(handle)).toEqual(parent);
        runtime.recordDotTokenUsage(parent.dot_id, usage.input_tokens + usage.output_tokens, {
          rootDir: root,
          now: () => new Date(time),
        });
        return { status: 'settled' };
      },
    },
    invoke: {
      mode: 'offline_fixture',
      provider: modelConfig.provider,
      model: modelConfig.model,
      invoke: vi.fn(async (call) => {
        if (kind === 'timeout') {
          advance(15_000);
          expect(call.signal.aborted).toBe(true);
          throw new Error('synthetic cancelled deadline');
        }
        return {
          text: JSON.stringify({
            disposition: 'apply_precedent',
            precedent_keys: snapshot.snapshot.evidence_refs.map((ref) => ref.source_key),
            rationale: 'Preserve fixed goals',
            applicability: ['Synthetic repair'],
          }),
          usage: { input_tokens: 40, output_tokens: 30 },
        };
      }),
    },
    persist: vi.fn((value, context) => {
      if (kind === 'persist_failure') throw new Error('synthetic receipt storage failure');
      return evidence.saveJudgmentEvidence(value, context);
    }),
  };
  const effectiveGate = dispatch.evaluateDotProposalGate(charter, proposal, {
    rootDir: root,
    now: () => new Date(time),
  });
  expect(effectiveGate.gate).toMatchObject({
    decision: approveFloor ? 'approve' : 'auto',
    executionMode: 'apply',
    shadow: false,
  });
  if (!approveFloor) expect(effectiveGate.gate.allowed).toBe(true);
  const deps: DotRuntimeDeps = {
    rootDir: root,
    now: () => new Date(time),
    hasRole: () => true,
    semanticJudgment: { qualification: 'offline_fixture', deps: observer },
    // This callback uses actual bounds/gate/route/ledger/WorkItem creation; no fabricated records.
    dispatch: (current, proposals) =>
      dispatch.dispatchDotProposals(current, proposals, {
        rootDir: root,
        operationKey,
        now: () => new Date(time),
      }).records,
    backend: {
      delegateTask: async () => `\`\`\`dot-proposals\n${JSON.stringify([proposal])}\n\`\`\``,
    },
    ...(entry === 'tool'
      ? {
          runLoop: async (options) => {
            options.executeTool!({ name: 'dot_propose_action', input: proposal });
            return {
              finalState: 'complete' as const,
              turnsRun: 1,
              goal: { budgetStats: { tokensUsed: 10 } },
            };
          },
        }
      : {}),
  };
  const receipt = await runtime.runDotWake(loaded, deps);
  expect(receipt.outcome, receipt.reason).toBe('delivered');
  const after = inspectBusiness();
  expect(after.actions).toHaveLength(1);
  expect(after.items).toHaveLength(approveFloor ? 0 : 1);
  expect(after.approvals).toHaveLength(approveFloor ? 1 : 0);
  expect(after.actions[0].status).toBe(approveFloor ? 'parked' : 'dispatched');
  const identity = identities.genericDotActionIdentity(charter, proposal, 0, operationKey);
  expect(after.actions[0].action_ref).toBe(identity.action_ref);
  expect(after.actions[0].admission?.semantic_hash).toBe(identity.admission?.semantic_hash);
  if (approveFloor) {
    expect(after.approvals[0]).toMatchObject({
      status: 'pending',
      accountability: { finalDecision: 'human_only' },
    });
    expect(after.actions[0].request_id).toBe(after.approvals[0].id);
  } else {
    expect(after.items[0]).toMatchObject({
      item_id: identities.dotAdmissionItemId(identity.action_ref),
      source_ref: identity.action_ref,
      status: 'ready',
      version: 1,
      context: {
        tenant_slug: data.scope.tenant_slug,
        organization_id: data.scope.organization_id,
        project_id: data.scope.project_id,
      },
      metadata: {
        dot_id: id,
        action_ref: identity.action_ref,
        requested_work_shape: 'pipeline',
        pipeline_ref: proposal.pipeline_ref,
      },
    });
    expect(after.notifications).toBe(0);
  }
  if (kind === 'off') {
    expect(observer.prepare).not.toHaveBeenCalled();
    expect(observer.invoke!.invoke).not.toHaveBeenCalled();
  } else {
    expect(observer.prepare).toHaveBeenCalledOnce();
    expect(observer.invoke!.invoke).toHaveBeenCalledOnce();
    expect(beforeObserver).toEqual(after); // Exact identities, versions, approval state and business deliveries unchanged.
    if (kind === 'timeout') expect(observer.persist).not.toHaveBeenCalled();
    else expect(observer.persist).toHaveBeenCalledOnce();
    if (kind === 'success')
      expect(vi.mocked(observer.persist!).mock.results[0].value).toMatchObject({
        status: 'persisted',
      });
  }
  // After exact per-case identity assertions, compare semantic projections across distinct isolated namespaces.
  return {
    action: {
      status: after.actions[0].status,
      decision: after.actions[0].decision,
      objective: after.actions[0].objective,
      pipeline: after.actions[0].pipeline_ref,
    },
    item: after.items.map((item) => ({
      status: item.status,
      version: item.version,
      context: item.context,
      requested_shape: item.metadata?.requested_work_shape,
      pipeline: item.metadata?.pipeline_ref,
    })),
    approval: after.approvals.map((record) => ({
      status: record.status,
      kind: record.kind,
      finalDecision: record.accountability?.finalDecision,
    })),
    inboxCount: after.inbox.length,
    notifications: after.notifications,
  };
}

describe('synthetic-policy real dispatcher admission is unchanged by semantic shadow', () => {
  it.each(['fence', 'tool'] as const)(
    'keeps actual action/WorkItem/approvals/deliveries identical on %s for success, persist failure and timeout',
    async (entry) => {
      const baseline = await scenario(entry, 'off', false);
      for (const kind of ['success', 'persist_failure', 'timeout'] as const)
        expect(await scenario(entry, kind, false)).toEqual(baseline);
    }
  );
  it.each(['fence', 'tool'] as const)(
    'preserves the real approve floor and pending request on %s without an extra WorkItem',
    async (entry) => {
      const baseline = await scenario(entry, 'off', true);
      for (const kind of ['success', 'persist_failure', 'timeout'] as const)
        expect(await scenario(entry, kind, true)).toEqual(baseline);
    }
  );
});
