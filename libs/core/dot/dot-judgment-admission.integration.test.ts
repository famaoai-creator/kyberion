/** Synthetic authored refs only: real admission/gate/store, no origin proof or executor authority. */
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { DotDispatchDeps } from './dot-dispatch.js';
import type { DotActionRecord } from './dot-action-ledger.js';
import type { DotCharter } from './dot-charter.js';

const notifications = vi.hoisted(() => ({ notify: vi.fn(() => true) }));
vi.mock('../surface/operator-notifications.js', async (original) => ({
  ...(await original<typeof import('../surface/operator-notifications.js')>()),
  notifyOperatorSync: notifications.notify,
}));
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const root = path.join(sourceRoot, 'active/shared/tmp', `vitest-judged-admission-${randomUUID()}`);
let bootstrapIo: typeof import('../secure-io.js');
let io: typeof import('../secure-io.js');
let dispatch: typeof import('./dot-dispatch.js');
let actions: typeof import('./dot-action-ledger.js');
let identity: typeof import('./dot-admission-identity.js');
let workInput: typeof import('./dot-work-item.js');
let coordination: typeof import('../workforce/work-coordination.js');
let approvals: typeof import('../governance/approval-store.js');
let bindings: typeof import('./dot-judgment-binding.js');
let latency: typeof import('../organization/judgment-latency-fixture.js');
let precedents: typeof import('../organization/judgment-precedents.js');
let evidence: typeof import('../organization/judgment-evidence.js');
let proposals: typeof import('./dot-proposals.js');
let json: typeof import('../foundation/json.js');
let foundation: typeof import('../foundation/io.js');
let state: typeof import('./dot-state-paths.js');
let recovery: typeof import('../surface/front-desk-recovery-receipt.js');
let serial = 0;
let policyVersion: string;
const now = () => new Date('2026-10-31T00:00:00.000Z');

beforeAll(async () => {
  bootstrapIo = await import('../secure-io.js');
  bootstrapIo.safeMkdir(root, { recursive: true });
  const copy = (from: string, to: string): void => {
    if (bootstrapIo.safeLstat(from).isDirectory()) {
      bootstrapIo.safeMkdir(to, { recursive: true });
      for (const name of bootstrapIo.safeReaddir(from))
        copy(path.join(from, name), path.join(to, name));
    } else bootstrapIo.safeCopyFileSync(from, to);
  };
  for (const name of ['schemas', 'governance', 'orchestration'])
    copy(
      path.join(sourceRoot, 'knowledge/product', name),
      path.join(root, 'knowledge/product', name)
    );
  const policyPath = path.join(root, 'knowledge/product/governance/autonomous-ops-policy.json');
  const policy = JSON.parse(bootstrapIo.safeReadFile(policyPath, { encoding: 'utf8' }) as string);
  policy.actions.dot_delegate_work.axis_scores = {
    scope: 0,
    reversibility: 0,
    sensitivity: 0,
    confidence: 0,
  };
  policyVersion = policy.version;
  bootstrapIo.safeWriteFile(policyPath, JSON.stringify(policy)); // Isolated fixture policy only.
  bootstrapIo.safeMkdir(path.join(root, 'knowledge/personal/tenants'), { recursive: true });
  bootstrapIo.safeWriteFile(
    path.join(root, 'knowledge/personal/tenants/synthetic-latency.json'),
    JSON.stringify({
      tenant_slug: 'synthetic-latency',
      display_name: 'Synthetic fixture',
      status: 'active',
      assigned_role: 'owner',
    })
  );
  bootstrapIo.safeWriteFile(path.join(root, 'package.json'), '{}');
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
    summary: 'Judged admission',
    status: 'active',
    tier: 'confidential',
    tenant_slug: 'synthetic-latency',
    organization_id: 'synthetic-org',
  } as Parameters<typeof saveProjectRecord>[0]);
  dispatch = await import('./dot-dispatch.js');
  actions = await import('./dot-action-ledger.js');
  identity = await import('./dot-admission-identity.js');
  workInput = await import('./dot-work-item.js');
  coordination = await import('../workforce/work-coordination.js');
  approvals = await import('../governance/approval-store.js');
  bindings = await import('./dot-judgment-binding.js');
  latency = await import('../organization/judgment-latency-fixture.js');
  precedents = await import('../organization/judgment-precedents.js');
  evidence = await import('../organization/judgment-evidence.js');
  proposals = await import('./dot-proposals.js');
  json = await import('../foundation/json.js');
  foundation = await import('../foundation/io.js');
  state = await import('./dot-state-paths.js');
  recovery = await import('../surface/front-desk-recovery-receipt.js');
});
afterEach(() => {
  vi.restoreAllMocks();
  coordination?.clearWorkCoordinationNamespace();
});
afterAll(() => {
  vi.unstubAllEnvs();
  bootstrapIo?.safeRmSync(root, { recursive: true, force: true });
  vi.resetModules();
});

function fixture() {
  const data = latency.createJudgmentLatencyFixture();
  const id = `judged-admission-${++serial}`;
  coordination.setWorkCoordinationNamespace(id);
  const charter: DotCharter = {
    ...structuredClone(data.charter),
    dot_id: id,
    authority: { ...data.charter.authority, authority_role: 'infrastructure_sentinel' },
    runtime: { heartbeat_id: id, semantic_judgment: { mode: 'off' } },
  };
  const proposal = proposals.normalizeDotProposal({
    title: 'Synthetic bounded repair',
    objective: 'Keep the original 100-user goal',
    work_shape: 'pipeline',
    pipeline_ref: latency.SYNTHETIC_LATENCY_PIPELINE_REF,
  });
  const judgmentBinding = {
    schema_version: '1' as const,
    work_ref: id,
    work_revision: '1',
    trigger_key: 'fixture-origin',
    scope_hash: precedents.judgmentCanonicalHash(data.scope),
    request_hash: 'a'.repeat(64),
    evidence_hash: 'b'.repeat(64),
    precedent_snapshot_hash: 'c'.repeat(64),
    policy_version: 'semantic-policy',
    rubric_version: 'rubric',
    evaluator_version: 'evaluator',
    model_config_hash: 'd'.repeat(64),
  };
  const parent = evidence.judgmentEvidenceParent({
    scope: data.scope,
    binding: judgmentBinding,
    effectRef: `effect-${id}`,
  });
  const bound = bindings.bindSyntheticDotJudgmentProposal({
    mode: 'synthetic_fixture',
    charter,
    proposal,
    scope: data.scope,
    judgmentBinding,
    originReceipt: { ...parent, attempt: 1, content_hash: 'e'.repeat(64) },
    effectRef: `effect-${id}`,
    effectPolicyVersion: policyVersion,
  });
  const deps: DotDispatchDeps = { rootDir: root, operationKey: 'same-wake', now };
  const gate = dispatch.evaluateDotProposalGate(charter, proposal, deps).gate;
  expect(gate).toMatchObject({
    allowed: true,
    decision: 'auto',
    executionMode: 'apply',
    shadow: false,
  });
  const items = () =>
    coordination
      .listWorkItems({}, { rootDir: root })
      .filter((item) => item.metadata?.dot_id === id);
  const rows = () => actions.currentDotActions(id, { rootDir: root });
  const send = (candidate = bound, overrides: Partial<DotDispatchDeps> = {}) =>
    dispatch.dispatchDotProposals(charter, [candidate], { ...deps, ...overrides });
  const recover = (overrides: Partial<DotDispatchDeps> = {}) =>
    dispatch.reconcileDotAdmissions(charter, { ...deps, ...overrides });
  const noExtraApproval = () =>
    expect(
      approvals
        .listApprovalRequests({})
        .filter((request) => request.source?.agentId === `dot:${id}`)
    ).toEqual([]);
  return { data, id, charter, proposal, bound, deps, items, rows, send, recover, noExtraApproval };
}
function interruptDispatchedAppend() {
  const io = foundation.getFoundationIo();
  const append = io.appendFile.bind(io);
  return vi.spyOn(io, 'appendFile').mockImplementation((file, content) => {
    if (file.endsWith('/dot-action-ledger.jsonl') && content.includes('"status":"dispatched"'))
      throw new Error('Synthetic interruption after WorkItem snapshot');
    append(file, content);
  });
}
function missingItem(f: ReturnType<typeof fixture>) {
  const result = f.send(f.bound, {
    createWorkItem: () => {
      throw new Error('Synthetic interruption before WorkItem');
    },
  });
  expect(result.records[0]).toMatchObject({
    status: 'admitted',
    semantic_judgment: f.bound.semantic_judgment,
  });
  expect(f.items()).toHaveLength(0);
  return result.records[0];
}

describe('synthetic judgment binding propagation through actual admission and WorkItem store', () => {
  it('preserves the original full binding on initial admission and actual WorkItem without granting executor authority', () => {
    const f = fixture();
    const original = JSON.stringify(f.bound);
    const beforeNotify = notifications.notify.mock.calls.length;
    const first = f.send().records[0];
    expect(first).toMatchObject({
      status: 'dispatched',
      semantic_judgment: f.bound.semantic_judgment,
      admission: { proposal: f.bound },
    });
    const item = f.items()[0];
    expect(f.items()).toHaveLength(1);
    expect(item.metadata?.semantic_judgment).toEqual(f.bound.semantic_judgment);
    expect(item.metadata?.pipeline_ref).toBe(f.bound.pipeline_ref);
    expect(item.item_id).toBe(identity.dotAdmissionItemId(first.action_ref));
    expect(JSON.stringify(f.bound)).toBe(original);
    f.noExtraApproval();
    expect(notifications.notify.mock.calls.length).toBe(beforeNotify);
    const shared = String(
      io.safeReadFile(path.join(root, actions.DOT_ACTION_LEDGER_PATH), { encoding: 'utf8' })
    );
    expect(shared).not.toContain('semantic_judgment');
    expect(shared).not.toContain('origin_receipt');
    expect(f.send().duplicates).toEqual([first.action_ref]);
    expect(f.items()).toEqual([item]);
  });
  it('recovers an actual missing WorkItem once using the unchanged bound admission proposal', () => {
    const f = fixture();
    const admitted = missingItem(f);
    expect(f.recover()).toMatchObject([
      {
        status: 'dispatched',
        action_ref: admitted.action_ref,
        semantic_judgment: f.bound.semantic_judgment,
      },
    ]);
    expect(f.items()).toHaveLength(1);
    const original = f.items()[0];
    expect(original.metadata?.semantic_judgment).toEqual(f.bound.semantic_judgment);
    expect(f.recover()).toEqual([]);
    expect(f.send().duplicates).toEqual([admitted.action_ref]);
    expect(f.items()).toEqual([original]);
    f.noExtraApproval();
  });
  it('reuses an actual committed snapshot after final ledger failure without changing its origin or creation version', () => {
    const f = fixture();
    const interruption = interruptDispatchedAppend();
    expect(f.send().records[0].status).toBe('admitted');
    expect(f.items()).toHaveLength(1);
    const original = f.items()[0];
    interruption.mockRestore();
    expect(f.recover()).toMatchObject([{ status: 'dispatched', work_item_id: original.item_id }]);
    expect(f.items()).toEqual([original]);
    expect(f.items()[0].version).toBe(1);
    expect(f.recover()).toEqual([]);
    f.noExtraApproval();
  });
  it('retains legitimate current edits on the real store path using its immutable original creation history', () => {
    const f = fixture();
    const interruption = interruptDispatchedAppend();
    f.send();
    interruption.mockRestore();
    const original = f.items()[0];
    const edited = coordination.updateWorkItem({
      rootDir: root,
      itemId: original.item_id,
      expectedVersion: original.version,
      priority: 'high',
      title: 'Legitimate later title',
      status: 'blocked',
    });
    expect(f.recover()).toMatchObject([{ status: 'dispatched', work_item_id: original.item_id }]);
    expect(f.items()).toEqual([edited]);
  });
  it('allows unchanged injected creation identity with later lifecycle status/version while never calling its create port', () => {
    const f = fixture();
    const interruption = interruptDispatchedAppend();
    f.send();
    interruption.mockRestore();
    const original = f.items()[0];
    const later = coordination.updateWorkItem({
      rootDir: root,
      itemId: original.item_id,
      expectedVersion: original.version,
      status: 'blocked',
    });
    const create = vi.fn(() => {
      throw new Error('Creation must not be repeated');
    });
    expect(
      f.recover({ createWorkItem: create, findWorkItemByActionRef: () => later })
    ).toMatchObject([{ status: 'dispatched' }]);
    expect(create).not.toHaveBeenCalled();
    expect(f.items()).toEqual([later]);
  });
  it('refuses changed binding semantics under the same operation without another WorkItem or action identity', () => {
    const f = fixture();
    const first = f.send().records[0];
    const original = f.items()[0];
    const changed = {
      ...f.bound,
      semantic_judgment: {
        ...f.bound.semantic_judgment,
        origin_receipt: {
          ...f.bound.semantic_judgment.origin_receipt,
          attempt: 2,
          content_hash: 'f'.repeat(64),
        },
      },
    };
    const replay = f.send(changed).records[0];
    expect(replay.action_ref).toBe(first.action_ref);
    expect(replay.reason).toMatch(/identity conflict/);
    expect(f.rows()).toEqual([first]);
    expect(f.items()).toEqual([original]);
    f.noExtraApproval();
  });
  it.each(['missing', 'null', 'changed-origin', 'legacy-to-judged'] as const)(
    'rejects existing WorkItem metadata %s before the injected existing-item fastpath',
    (condition) => {
      const f = fixture();
      const interruption = interruptDispatchedAppend();
      if (condition === 'legacy-to-judged')
        dispatch.dispatchDotProposals(f.charter, [f.proposal], f.deps);
      else f.send();
      interruption.mockRestore();
      const original = f.items()[0];
      expect(original).toBeDefined();
      const metadata = { ...original.metadata };
      if (condition === 'missing') delete metadata.semantic_judgment;
      if (condition === 'null') metadata.semantic_judgment = null;
      if (condition === 'changed-origin')
        metadata.semantic_judgment = {
          ...f.bound.semantic_judgment,
          origin_receipt: { ...f.bound.semantic_judgment.origin_receipt, attempt: 2 },
        };
      if (condition === 'legacy-to-judged') metadata.semantic_judgment = f.bound.semantic_judgment;
      const changed = coordination.updateWorkItem({
        rootDir: root,
        itemId: original.item_id,
        expectedVersion: original.version,
        metadata,
      });
      const create = vi.fn(() => {
        throw new Error('Must not overwrite existing metadata');
      });
      const recovered = f.recover({
        createWorkItem: create,
        findWorkItemByActionRef: () =>
          coordination.getWorkItem(original.item_id, { rootDir: root }),
      });
      expect(recovered[0].status).toBe('admitted');
      expect(recovered[0].reason).toMatch(/WorkItem creation failed/);
      expect(create).not.toHaveBeenCalled();
      expect(f.items()).toEqual([changed]);
      f.noExtraApproval();
    }
  );
  it.each([
    'missing-action-ref',
    'wrong-context',
    'wrong-source-ref',
    'wrong-pipeline',
    'wrong-title',
    'wrong-item-id',
    'unsupported-priority-edit',
  ] as const)(
    'rejects injected current snapshots with %s instead of filling their immutable creation fields',
    (condition) => {
      const f = fixture();
      const interruption = interruptDispatchedAppend();
      f.send();
      interruption.mockRestore();
      const original = f.items()[0];
      const injected = structuredClone(original);
      if (condition === 'missing-action-ref') delete injected.metadata!.action_ref;
      if (condition === 'wrong-context')
        injected.context = { ...injected.context, tenant_slug: 'other-tenant' };
      if (condition === 'wrong-source-ref') injected.source_ref = 'other-source';
      if (condition === 'wrong-pipeline') injected.metadata!.pipeline_ref = 'pipelines/other.json';
      if (condition === 'wrong-title') injected.title = 'Changed title';
      if (condition === 'wrong-item-id') injected.item_id = 'other-item-id';
      if (condition === 'unsupported-priority-edit') injected.priority = 'high';
      const create = vi.fn(() => {
        throw new Error('Creation must not be repeated');
      });
      expect(
        f.recover({ createWorkItem: create, findWorkItemByActionRef: () => injected })
      ).toMatchObject([
        { status: 'admitted', reason: expect.stringContaining('WorkItem creation failed') },
      ]);
      expect(create).not.toHaveBeenCalled();
      expect(f.items()).toEqual([original]);
      f.noExtraApproval();
    }
  );
  it('capacity recovery keeps the original bound proposal instead of routing it through the model normalizer', () => {
    const f = fixture();
    const ordinary = coordination.createWorkItem({
      rootDir: root,
      title: 'Ordinary fixture reservation',
      description: 'No executor',
      status: 'ready',
      projectId: f.data.scope.project_id,
      context: {
        tenant_slug: f.data.scope.tenant_slug,
        organization_id: f.data.scope.organization_id,
        project_id: f.data.scope.project_id,
        work_shape: 'routine_operation',
      },
      metadata: { dot_id: f.id },
    });
    const waiting = f.send().records[0];
    expect(waiting.status).toBe('waiting_capacity');
    expect(waiting.semantic_judgment).toEqual(f.bound.semantic_judgment);
    expect(f.items()).toHaveLength(1);
    coordination.updateWorkItem({
      rootDir: root,
      itemId: ordinary.item_id,
      expectedVersion: ordinary.version,
      status: 'done',
    });
    const resumed = dispatch.settleDotCapacityActions(f.charter, f.deps);
    expect(resumed).toMatchObject([
      {
        status: 'dispatched',
        action_ref: waiting.action_ref,
        semantic_judgment: f.bound.semantic_judgment,
      },
    ]);
    expect(
      f.items().filter((item) => item.metadata?.action_ref === waiting.action_ref)
    ).toHaveLength(1);
    expect(dispatch.settleDotCapacityActions(f.charter, f.deps)).toEqual([]);
    f.noExtraApproval();
  });
  it.each(['scope', 'charter', 'proposal-hash'] as const)(
    'rejects initial %s mismatch before any actual WorkItem creation',
    (condition) => {
      const f = fixture();
      if (condition === 'scope')
        f.charter.scope = { ...f.charter.scope, tenant_slug: 'other-tenant' };
      if (condition === 'charter') f.charter.purpose = 'Changed original charter';
      const candidate =
        condition === 'proposal-hash' ? { ...f.bound, objective: 'Changed target' } : f.bound;
      expect(() => f.send(candidate)).toThrow();
      expect(f.items()).toEqual([]);
      f.noExtraApproval();
    }
  );
  it.each(['shadow', 'diagnostic', 'paused', 'pipeline-removed', 'shape-removed'] as const)(
    'rejects hand-authored current %s charter hashes instead of trusting a matching hash alone',
    (condition) => {
      const f = fixture();
      if (condition === 'shadow') f.charter.runtime.semantic_judgment = { mode: 'shadow' };
      if (condition === 'diagnostic') f.charter.runtime.execution_mode = 'front_desk_diagnostic';
      if (condition === 'paused') f.charter.status = 'paused';
      if (condition === 'pipeline-removed') f.charter.authority.allowed_pipelines = [];
      if (condition === 'shape-removed') f.charter.authority.allowed_work_shapes = [];
      const forged = {
        ...f.bound,
        semantic_judgment: {
          ...f.bound.semantic_judgment,
          charter_hash: bindings.dotJudgmentCharterHash(f.charter),
        },
      };
      expect(() => identity.genericDotActionIdentity(f.charter, forged, 0, 'same-wake')).toThrow();
      expect(() => f.send(forged)).toThrow();
      const admitted = identity.genericDotActionIdentity(
        { ...f.charter, ...f.data.charter, dot_id: f.id },
        f.proposal,
        0,
        'same-wake'
      );
      const record: DotActionRecord = {
        scope: f.charter.scope,
        ...admitted,
        admission: { ...admitted.admission!, proposal: forged, semantic_hash: '' },
        semantic_judgment: forged.semantic_judgment,
        dot_id: f.id,
        actor_id: `dot:${f.id}`,
        action_id: forged.action_id,
        title: forged.title,
        objective: forged.objective,
        work_shape: forged.work_shape,
        pipeline_ref: forged.pipeline_ref,
        proposal_hash: actions.dotProposalHash(f.id, forged),
        status: 'admitted',
        at: now().toISOString(),
      };
      // Same generic semantic hash algorithm, never a new judgment-specific admission hash.
      record.admission!.semantic_hash = recovery.recoveryEvidenceHash(forged);
      expect(() => workInput.dotWorkItemInput(f.charter, record, root)).toThrow('original active');
      expect(f.items()).toEqual([]);
      f.noExtraApproval();
    }
  );
  it('capacity recovery under a changed shadow charter cannot mutate admission or ask for approval', () => {
    const f = fixture();
    const first = f.send(f.bound, { countOpenWorkItems: () => 1 }).records[0];
    expect(first.status).toBe('waiting_capacity');
    const before = f.rows();
    f.charter.runtime.semantic_judgment = { mode: 'shadow' };
    expect(() =>
      dispatch.settleDotCapacityActions(f.charter, { ...f.deps, countOpenWorkItems: () => 0 })
    ).toThrow();
    expect(f.rows()).toEqual(before);
    expect(f.items()).toEqual([]);
    f.noExtraApproval();
  });
  it.each(['missing-private', 'corrupt-mirror'] as const)(
    'fails closed during %s recovery with no legacy promotion',
    (condition) => {
      const f = fixture();
      const admitted = missingItem(f);
      const file = path.join(
        root,
        state.dotStatePath({ scope: f.charter.scope }, 'action-ledger.jsonl')
      );
      if (condition === 'missing-private') io.safeRmSync(file);
      else {
        const malformed: DotActionRecord = structuredClone(admitted);
        delete malformed.semantic_judgment;
        json.writeJsonLines(file, [malformed]);
        const index = actions
          .readDotActionLedger({ rootDir: root })
          .filter((row) => row.action_ref !== admitted.action_ref);
        const originalIndex = {
          scope: admitted.scope,
          private_content_hash: actions.dotActionRecordHash(malformed),
          action_ref: admitted.action_ref,
          dot_id: admitted.dot_id,
          actor_id: admitted.actor_id,
          action_id: admitted.action_id,
          title: '[scoped action]',
          objective: '[scoped action]',
          work_shape: admitted.work_shape,
          status: admitted.status,
          proposal_hash: admitted.proposal_hash,
          at: admitted.at,
          work_item_id: admitted.work_item_id,
        };
        json.writeJsonLines(path.join(root, actions.DOT_ACTION_LEDGER_PATH), [
          ...index,
          originalIndex,
        ]);
      }
      expect(() => f.recover()).toThrow();
      expect(f.items()).toEqual([]);
      f.noExtraApproval();
    }
  );
  it('refuses judged legacy reconstruction and leaves ordinary old admission metadata absent', () => {
    const f = fixture();
    const first = f.send().records[0];
    const incomplete = { ...first };
    delete incomplete.admission;
    expect(() => identity.admissionForDotRecord(f.charter, incomplete)).toThrow(
      /legacy reconstruction/
    );
    expect(() => workInput.dotWorkItemInput(f.charter, incomplete, root)).toThrow();
    const legacy = fixture();
    const row = dispatch.dispatchDotProposals(legacy.charter, [legacy.proposal], legacy.deps)
      .records[0];
    expect(row.status).toBe('dispatched');
    expect(row).not.toHaveProperty('semantic_judgment');
    expect(legacy.items()).toHaveLength(1);
    expect(legacy.items()[0].metadata).not.toHaveProperty('semantic_judgment');
    expect(legacy.items()[0].metadata?.pipeline_ref).toBe(legacy.proposal.pipeline_ref);
    legacy.noExtraApproval();
  });
});
