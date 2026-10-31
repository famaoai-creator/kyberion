/** Offline human-decision surface fixture: actual approval/admission stores, no real user grant or executor. */
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequestRecord } from '../governance/approval-store.js';
import type { DotDispatchDeps } from './dot-dispatch.js';
import type { DotCharter } from './dot-charter.js';
const notifications = vi.hoisted(() => ({ notify: vi.fn(() => true) }));
vi.mock('../surface/operator-notifications.js', async (original) => ({
  ...(await original<typeof import('../surface/operator-notifications.js')>()),
  notifyOperatorSync: notifications.notify,
}));
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const root = path.join(sourceRoot, 'active/shared/tmp', `vitest-judged-approval-${randomUUID()}`);
const baseTime = Date.parse('2026-10-31T00:00:00.000Z');
const channel = 'autonomy';
let bootstrap: typeof import('../secure-io.js');
let io: typeof import('../secure-io.js');
let dispatch: typeof import('./dot-dispatch.js');
let actions: typeof import('./dot-action-ledger.js');
let coordination: typeof import('../workforce/work-coordination.js');
let approvals: typeof import('../governance/approval-store.js');
let bindings: typeof import('./dot-judgment-binding.js');
let latency: typeof import('../organization/judgment-latency-fixture.js');
let precedents: typeof import('../organization/judgment-precedents.js');
let evidence: typeof import('../organization/judgment-evidence.js');
let proposals: typeof import('./dot-proposals.js');
let feedback: typeof import('./dot-feedback.js');
let events: typeof import('../event-scope.js');
let foundation: typeof import('../foundation/io.js');
let serial = 0;
let policyVersion: string;

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
  policyVersion = policy.version;
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
  // Model the existing signed-in human surface port, not an agent decision or a shipped server.
  vi.stubEnv('SYSTEM_ROLE', 'operator_surface');
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(baseTime);
  io = await import('../secure-io.js');
  const { saveProjectRecord } = await import('../project/project-registry.js');
  saveProjectRecord({
    project_id: 'synthetic-project',
    name: 'Fixture',
    summary: 'Judged approval',
    status: 'active',
    tier: 'confidential',
    tenant_slug: 'synthetic-latency',
    organization_id: 'synthetic-org',
  } as Parameters<typeof saveProjectRecord>[0]);
  dispatch = await import('./dot-dispatch.js');
  actions = await import('./dot-action-ledger.js');
  coordination = await import('../workforce/work-coordination.js');
  approvals = await import('../governance/approval-store.js');
  bindings = await import('./dot-judgment-binding.js');
  latency = await import('../organization/judgment-latency-fixture.js');
  precedents = await import('../organization/judgment-precedents.js');
  evidence = await import('../organization/judgment-evidence.js');
  proposals = await import('./dot-proposals.js');
  feedback = await import('./dot-feedback.js');
  events = await import('../event-scope.js');
  foundation = await import('../foundation/io.js');
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

function fixture(judged = true) {
  const data = latency.createJudgmentLatencyFixture();
  const id = `judged-approval-${++serial}`;
  coordination.setWorkCoordinationNamespace(id);
  const charter: DotCharter = {
    ...structuredClone(data.charter),
    dot_id: id,
    authority: { ...data.charter.authority, authority_role: 'infrastructure_sentinel' },
    decisions: { default_decision: 'approve' },
    runtime: { heartbeat_id: id, semantic_judgment: { mode: 'off' } },
  };
  const proposal = proposals.normalizeDotProposal({
    title: 'Bounded synthetic repair',
    objective: 'Preserve all original goals',
    work_shape: 'pipeline',
    pipeline_ref: latency.SYNTHETIC_LATENCY_PIPELINE_REF,
  });
  const binding = {
    schema_version: '1' as const,
    work_ref: id,
    work_revision: '1',
    trigger_key: 'trigger',
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
    binding,
    effectRef: `effect-${id}`,
  });
  const bound = bindings.bindSyntheticDotJudgmentProposal({
    mode: 'synthetic_fixture',
    charter,
    proposal,
    scope: data.scope,
    judgmentBinding: binding,
    originReceipt: { ...parent, attempt: 1, content_hash: 'e'.repeat(64) },
    effectRef: `effect-${id}`,
    effectPolicyVersion: policyVersion,
  });
  const clock = { time: baseTime };
  const now = () => new Date(clock.time);
  const onRejection = vi.fn();
  const deps: DotDispatchDeps = {
    rootDir: root,
    operationKey: 'original-wake',
    now,
    feedback: { onRejection },
  };
  const parked = dispatch.dispatchDotProposals(charter, [judged ? bound : proposal], deps)
    .records[0];
  expect(parked.status).toBe('parked');
  expect(parked.request_id).toBeTruthy();
  const read = () => approvals.loadApprovalRequest(channel, parked.request_id!)!;
  const original = read();
  expect(original.status).toBe('pending');
  if (judged) {
    expect(original.accountability).toMatchObject({
      finalDecision: 'human_only',
      payloadHash: parked.admission!.semantic_hash,
      effectBinding: `dot-judgment:${parked.action_ref}`,
    });
    expect(original.scope).toEqual(events.normalizeEventScope(data.scope));
  }
  const decide = (decision: 'approved' | 'rejected') => {
    const current = read();
    return approvals.decideApprovalRequest('infrastructure_sentinel', {
      channel: current.channel,
      storageChannel: channel,
      requestId: current.id,
      decision,
      decidedBy: 'user:fixture-owner',
      decidedByType: 'human',
      authenticated: true,
      authMethod: 'surface_session',
      deciderIdentitySource: 'server_resolved',
      presentedDigest: approvals.computeApprovalPresentedDigest(current),
      deciderPrincipal: {
        actor: { kind: 'human', id: 'user:fixture-owner' },
        source: 'oidc',
        provider: 'offline-fixture-human-surface',
        principalId: 'user:fixture-owner',
      },
    });
  };
  const items = () =>
    coordination
      .listWorkItems({}, { rootDir: root })
      .filter((item) => item.metadata?.dot_id === id);
  const learned = () => feedback.readDotFeedback(id, { rootDir: root, now });
  const rows = () => actions.currentDotActions(id, { rootDir: root });
  const settle = (overrides: Partial<DotDispatchDeps> = {}) =>
    dispatch.settleDotParkedActions(charter, { ...deps, ...overrides });
  const recover = (overrides: Partial<DotDispatchDeps> = {}) =>
    dispatch.reconcileDotAdmissions(charter, { ...deps, ...overrides });
  return {
    id,
    data,
    charter,
    proposal,
    bound,
    parked,
    original,
    clock,
    deps,
    read,
    decide,
    items,
    learned,
    rows,
    settle,
    recover,
    onRejection,
  };
}
function altered(record: ApprovalRequestRecord): ApprovalRequestRecord {
  return { ...record, accountability: { ...record.accountability!, payloadHash: 'f'.repeat(64) } };
}

describe('actual store-bound judged approval and feedback boundaries', () => {
  it('uses the actual signed-in fixture decision store before creating one WorkItem and one positive feedback', () => {
    const f = fixture();
    const approved = f.decide('approved');
    expect(approved.status).toBe('approved');
    expect(approved.verifiedPresentedDigest).toBeTruthy();
    expect(f.items()).toEqual([]);
    expect(f.learned()).toEqual([]);
    expect(f.settle()).toMatchObject([{ status: 'dispatched' }]);
    const item = f.items()[0];
    expect(f.items()).toHaveLength(1);
    expect(item.metadata?.semantic_judgment).toEqual(f.bound.semantic_judgment);
    expect(item.metadata?.approval_request_id).toBe(f.original.id);
    expect(f.learned()).toMatchObject([
      { outcome: 'approved', decided_by: 'user:fixture-owner', decided_by_type: 'human' },
    ]);
    expect(f.settle()).toEqual([]);
    expect(f.recover()).toEqual([]);
    expect(f.items()).toEqual([item]);
    expect(f.learned()).toHaveLength(1);
  });
  it.each(['rejected', 'expired'] as const)(
    'retains legitimate %s feedback and decline flow after exact body matching',
    (status) => {
      const f = fixture();
      if (status === 'rejected') f.decide('rejected');
      else {
        f.clock.time = Date.parse(f.original.expiresAt!) + 1;
        vi.setSystemTime(f.clock.time);
      }
      expect(f.settle()).toMatchObject([{ status: 'declined' }]);
      expect(f.items()).toEqual([]);
      expect(f.learned()).toMatchObject([{ outcome: status }]);
      expect(f.settle()).toEqual([]);
      expect(f.learned()).toHaveLength(1);
      expect(f.onRejection).toHaveBeenCalledTimes(status === 'rejected' ? 1 : 0);
    }
  );
  it.each([
    'missing-payload',
    'missing-accountability',
    'wrong-payload',
    'wrong-effect',
    'wrong-id',
    'wrong-actor',
    'wrong-source',
    'wrong-action',
    'wrong-tenant',
    'wrong-project',
  ] as const)(
    'refuses %s from the approval read boundary before feedback or admission',
    (condition) => {
      const f = fixture();
      f.decide('approved');
      const changed = structuredClone(f.read());
      if (condition === 'missing-payload') delete changed.accountability!.payloadHash;
      if (condition === 'missing-accountability') delete changed.accountability;
      if (condition === 'wrong-payload') changed.accountability!.payloadHash = 'f'.repeat(64);
      if (condition === 'wrong-effect')
        changed.accountability!.effectBinding = 'dot-judgment:other';
      if (condition === 'wrong-id') changed.id = 'other-id';
      if (condition === 'wrong-actor') changed.requestedBy = 'dot:other';
      if (condition === 'wrong-source') changed.source!.agentId = 'dot:other';
      if (condition === 'wrong-action') changed.source!.actionId = 'other-action';
      if (condition === 'wrong-tenant')
        changed.scope = events.normalizeEventScope({
          ...f.data.scope,
          tenant_slug: 'other-tenant',
        });
      if (condition === 'wrong-project')
        changed.scope = events.normalizeEventScope({
          ...f.data.scope,
          project_id: 'other-project',
        });
      expect(f.settle({ loadApproval: () => changed })).toEqual([]);
      expect(f.rows()).toEqual([f.parked]);
      expect(f.items()).toEqual([]);
      expect(f.learned()).toEqual([]);
    }
  );
  it.each(['approved', 'applied'] as const)(
    'does not turn an expired %s read into work or positive feedback',
    (status) => {
      const f = fixture();
      f.decide('approved');
      f.clock.time = Date.parse(f.original.expiresAt!) + 1;
      vi.setSystemTime(f.clock.time);
      expect(f.settle({ loadApproval: () => ({ ...f.read(), status }) })).toEqual([]);
      expect(f.items()).toEqual([]);
      expect(f.learned()).toEqual([]);
      expect(f.rows()).toEqual([f.parked]);
    }
  );
  it('does not record negative learning for a rejected approval whose bound payload differs', () => {
    const f = fixture();
    f.decide('rejected');
    expect(f.settle({ loadApproval: () => altered(f.read()) })).toEqual([]);
    expect(f.rows()).toEqual([f.parked]);
    expect(f.items()).toEqual([]);
    expect(f.learned()).toEqual([]);
    expect(f.onRejection).not.toHaveBeenCalled();
  });
  it('refuses a changed current charter before recording an otherwise valid approval', () => {
    const f = fixture();
    f.decide('approved');
    f.charter.purpose = 'Changed current bounds';
    expect(f.settle()).toEqual([]);
    expect(f.rows()).toEqual([f.parked]);
    expect(f.items()).toEqual([]);
    expect(f.learned()).toEqual([]);
  });
  it('uses the existing store revocation refusal before any judged approval feedback or work', async () => {
    const f = fixture();
    f.decide('approved');
    const { revokeApprovalRequest } = await import('../governance/approval-revocation.js');
    revokeApprovalRequest('infrastructure_sentinel', {
      channel: f.original.channel,
      storageChannel: channel,
      requestId: f.original.id,
      revokedBy: 'user:fixture-owner',
      reason: 'Fixture revocation',
    });
    expect(f.read().revocation).toBeDefined();
    expect(f.settle()).toEqual([]);
    expect(f.rows()).toEqual([f.parked]);
    expect(f.items()).toEqual([]);
    expect(f.learned()).toEqual([]);
  });
  it('rechecks inside the admission lock so changed same-id body leaves the parked record untouched', () => {
    const f = fixture();
    f.decide('approved');
    let reads = 0;
    expect(
      f.settle({ loadApproval: () => (++reads === 1 ? f.read() : altered(f.read())) })
    ).toMatchObject([{ status: 'parked' }]);
    expect(reads).toBe(2);
    expect(f.rows()).toEqual([f.parked]);
    expect(f.items()).toEqual([]);
    expect(f.learned()).toEqual([]);
  });
  it('rechecks immediately before creation, then recovers only with the same current payload and one feedback', () => {
    const f = fixture();
    f.decide('approved');
    let reads = 0;
    expect(
      f.settle({ loadApproval: () => (++reads < 3 ? f.read() : altered(f.read())) })
    ).toMatchObject([{ status: 'admitted' }]);
    expect(f.items()).toEqual([]);
    expect(f.learned()).toEqual([]);
    expect(f.rows()[0].semantic_judgment).toEqual(f.parked.semantic_judgment);
    expect(f.recover()).toMatchObject([{ status: 'dispatched' }]);
    expect(f.items()).toHaveLength(1);
    expect(f.learned()).toMatchObject([{ outcome: 'approved' }]);
    expect(f.recover()).toEqual([]);
    expect(f.learned()).toHaveLength(1);
  });
  it('after-create drift suppresses feedback but cannot undo the one already committed internal WorkItem', () => {
    const f = fixture();
    f.decide('approved');
    let drift = false;
    const settled = f.settle({
      loadApproval: () => (drift ? altered(f.read()) : f.read()),
      createWorkItem: (input) => {
        const item = coordination.createWorkItemIfAbsent(
          input as Parameters<typeof coordination.createWorkItemIfAbsent>[0]
        );
        drift = true;
        return item;
      },
    });
    expect(settled).toMatchObject([{ status: 'dispatched' }]);
    expect(f.items()).toHaveLength(1);
    const item = f.items()[0];
    expect(f.learned()).toEqual([]);
    expect(f.settle()).toEqual([]);
    expect(f.recover()).toEqual([]);
    expect(f.items()).toEqual([item]);
    expect(f.learned()).toEqual([]);
  });
  it('admitted recovery requires fresh proof even when the actual WorkItem already exists', () => {
    const f = fixture();
    f.decide('approved');
    const io = foundation.getFoundationIo();
    const append = io.appendFile.bind(io);
    const spy = vi.spyOn(io, 'appendFile').mockImplementation((file, content) => {
      if (file.endsWith('/dot-action-ledger.jsonl') && content.includes('"status":"dispatched"'))
        throw new Error('Synthetic final receipt interruption');
      append(file, content);
    });
    expect(() => f.settle()).toThrow('Synthetic final receipt interruption');
    spy.mockRestore();
    const original = f.items()[0];
    expect(original).toBeDefined();
    expect(f.rows()[0].status).toBe('admitted');
    expect(f.recover({ loadApproval: () => altered(f.read()) })).toMatchObject([
      { status: 'admitted' },
    ]);
    expect(f.items()).toEqual([original]);
    expect(f.learned()).toEqual([]);
    expect(f.recover()).toMatchObject([{ status: 'dispatched' }]);
    expect(f.items()).toEqual([original]);
    expect(f.learned()).toHaveLength(1);
  });
  it('keeps ordinary legacy approvals compatible without adding a judgment payload binding', () => {
    const f = fixture(false);
    expect(f.original.accountability?.payloadHash).toBeUndefined();
    f.decide('approved');
    expect(f.settle()).toMatchObject([{ status: 'dispatched' }]);
    expect(f.items()).toHaveLength(1);
    expect(f.items()[0].metadata).not.toHaveProperty('semantic_judgment');
    expect(f.learned()).toMatchObject([{ outcome: 'approved' }]);
  });
});
