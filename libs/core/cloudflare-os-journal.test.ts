import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeReadFile, safeWriteFile } from './secure-io.js';
import { auditChain } from './governance/audit-chain.js';
import {
  appendJournalEventLocked,
  controlPlaneNamespaceFor,
  controlPlaneRuntimeRoot,
  controlPlaneJournalPath,
  foldObservationAggregate,
  journalFullParseCountForTests,
  listControlPlaneNamespaceDirs,
  readJournalTail,
  setControlPlaneRuntimeRootForTests,
  type ControlPlaneJournalEvent,
  type ObservationAggregate,
} from './cloudflare-os-journal.js';
import { CloudflareOsControlPlane } from './cloudflare-os-control-plane.js';
import { mintScopeEnvelope, withScopeEnvelope } from './scope-envelope.js';
import {
  decideApprovalRequest,
  drainPendingSteeringApprovalExecutions,
  loadApprovalRequest,
} from './governance/approval-store.js';

let testRoot: string;
let counter = 0;

beforeEach(() => {
  counter += 1;
  testRoot = pathResolver.shared(`tmp/cloudflare-os-journal-test-${process.pid}-${counter}`);
  safeMkdir(testRoot, { recursive: true });
  setControlPlaneRuntimeRootForTests(testRoot);
  vi.spyOn(auditChain, 'record').mockImplementation(() => ({}) as never);
});

afterEach(() => {
  setControlPlaneRuntimeRootForTests(undefined);
  vi.restoreAllMocks();
});

const heldRecord = (overrides: Record<string, unknown> = {}) => ({
  id: 'held-1',
  op: 'service:create_issue',
  missionId: 'mission-j',
  tenantSlug: 'tenant-a',
  submittedBy: 'agent:x',
  status: 'pending',
  submittedAt: '2026-10-03T00:00:00Z',
  autoApproved: false,
  effectBinding: 'service:create_issue',
  payloadHash: 'hash',
  dependsOn: [],
  ...overrides,
});

describe('controlPlaneNamespaceFor', () => {
  it('routes tenant-scoped records into <tier>/<tenant>', () => {
    const ns = controlPlaneNamespaceFor('observation', {
      tenantSlug: 'tenant-a',
      tier: 'confidential',
    });
    expect(ns.key).toBe('confidential/tenant-a');
    expect(ns.quarantined).toBe(false);
  });

  it('routes shared collections into <tier>/shared', () => {
    const ns = controlPlaneNamespaceFor('auto_rule', { op: 'x', actionTag: 'y' });
    expect(ns.key).toBe('confidential/shared');
  });

  it('quarantines tenantless tenant-scoped records', () => {
    expect(controlPlaneNamespaceFor('held', { missionId: 'm' }).quarantined).toBe(true);
    expect(controlPlaneNamespaceFor('observation', { tier: 'public' }).quarantined).toBe(true);
  });

  it('quarantines records whose tenant contradicts the minted envelope', () => {
    const envelope = mintScopeEnvelope({
      env: {
        KYBERION_TIER: 'confidential',
        KYBERION_TENANT: 'tenant-b',
        MISSION_ID: 'mission-env',
      } as NodeJS.ProcessEnv,
      policy: { purpose: 'ns test' },
    });
    const ns = withScopeEnvelope(envelope, () =>
      controlPlaneNamespaceFor('observation', { tenantSlug: 'tenant-a', tier: 'confidential' })
    );
    expect(ns.quarantined).toBe(true);
  });
});

describe('journal append and catch-up', () => {
  it('appends events with increasing seq and reads the tail', () => {
    const ns = controlPlaneNamespaceFor('observation', {
      tenantSlug: 'tenant-a',
      tier: 'confidential',
    });
    const seq1 = appendJournalEventLocked(
      ns,
      0,
      { kind: 'observation', records: [{ id: 'o1' }] },
      () => {
        throw new Error('no tail expected');
      }
    );
    const seq2 = appendJournalEventLocked(
      ns,
      seq1,
      { kind: 'observation', records: [{ id: 'o2' }] },
      () => {
        throw new Error('no tail expected');
      }
    );
    expect(seq2).toBe(seq1 + 1);
    const { events, lastSeq } = readJournalTail(ns.dir, 0);
    expect(events).toHaveLength(2);
    expect(events[0].records[0].id).toBe('o1');
    expect(lastSeq).toBe(seq2);
  });

  it('delivers unseen tail events to the writer for catch-up', () => {
    const ns = controlPlaneNamespaceFor('held', { tenantSlug: 'tenant-a' });
    appendJournalEventLocked(ns, 0, { kind: 'held', records: [heldRecord()] }, () => {});
    // A second process appended seq 1; the next writer starts at seq 0 and must see it.
    const seen: ControlPlaneJournalEvent[] = [];
    appendJournalEventLocked(
      ns,
      0,
      { kind: 'held', records: [heldRecord({ id: 'held-2' })] },
      (tail) => seen.push(...tail)
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].records[0].id).toBe('held-1');
  });
});

describe('observation aggregates', () => {
  it('folds observations by mission × resource_ref × tier', () => {
    const aggregates = new Map<string, ObservationAggregate>();
    const base = {
      id: 'o1',
      missionId: 'm1',
      service: 'github',
      resourceRef: 'repo:x',
      tier: 'public' as const,
      purpose: 'p',
      summary: 's',
      observedAt: '2026-10-03T00:00:00Z',
    };
    foldObservationAggregate(aggregates, base);
    foldObservationAggregate(aggregates, { ...base, id: 'o2', observedAt: '2026-10-03T01:00:00Z' });
    const aggregate = [...aggregates.values()];
    expect(aggregate).toHaveLength(1);
    expect(aggregate[0]).toMatchObject({ count: 2, missionId: 'm1', resourceRef: 'repo:x' });
    expect(aggregate[0].firstObservedAt).toBe('2026-10-03T00:00:00Z');
    expect(aggregate[0].lastObservedAt).toBe('2026-10-03T01:00:00Z');
  });
});

describe('control-plane journal persistence', () => {
  const submit = (cp: CloudflareOsControlPlane, overrides: Record<string, unknown> = {}) =>
    cp.submitHeldAction({
      missionId: 'mission-j',
      tenantSlug: 'tenant-a',
      submittedBy: 'agent:x',
      op: 'service:create_issue',
      params: { title: 'x' },
      persistParams: true,
      apply: async () => ({ ok: true }),
      ...overrides,
    });

  it('writes held actions to the tenant-namespaced journal and replays them', () => {
    const cp1 = new CloudflareOsControlPlane();
    const record = submit(cp1);
    const journalPath = path.join(
      testRoot,
      'confidential',
      'tenant-a',
      'cloudflare-os',
      'journal.jsonl'
    );
    const { events } = readJournalTail(path.dirname(journalPath), 0);
    expect(events.some((e) => e.kind === 'held' && e.records.some((r) => r.id === record.id))).toBe(
      true
    );

    const cp2 = new CloudflareOsControlPlane();
    expect(cp2.listHeldActions('mission-j').map((r) => r.id)).toContain(record.id);
  });

  it('aggregates observations and exposes rollups', () => {
    const cp = new CloudflareOsControlPlane();
    cp.recordObservation({
      missionId: 'mission-j',
      service: 'github',
      resourceRef: 'repo:x',
      tier: 'public',
      tenantSlug: 'tenant-a',
      purpose: 'p',
      summary: 's',
    });
    cp.recordObservation({
      missionId: 'mission-j',
      service: 'github',
      resourceRef: 'repo:x',
      tier: 'public',
      tenantSlug: 'tenant-a',
      purpose: 'p',
      summary: 's2',
    });
    const aggregates = cp.listObservationAggregates('mission-j');
    expect(aggregates).toHaveLength(1);
    expect(aggregates[0].count).toBe(2);
  });

  it('catches up cross-instance writes via the journal tail', () => {
    const cp1 = new CloudflareOsControlPlane();
    const cp2 = new CloudflareOsControlPlane();
    cp1.recordObservation({
      missionId: 'mission-j',
      service: 'github',
      resourceRef: 'repo:y',
      tier: 'confidential',
      tenantSlug: 'tenant-a',
      purpose: 'p',
      summary: 'first instance observation',
    });
    // cp2 projects taint — the refresh must see cp1's observation.
    const taint = cp2.projectTaint('mission-j');
    expect(taint.tenants).toContain('tenant-a');
    expect(taint.highestTier).toBe('confidential');
  });

  it('migrates the legacy flat control-plane.json into tenant journals', () => {
    const legacyDir = path.join(testRoot, 'cloudflare-os');
    safeMkdir(legacyDir, { recursive: true });
    const legacyState = {
      version: 1,
      held: [heldRecord()],
      introductions: [],
      observations: [
        {
          id: 'o-legacy',
          missionId: 'mission-j',
          service: 'github',
          resourceRef: 'repo:x',
          tier: 'confidential',
          tenantSlug: 'tenant-a',
          purpose: 'p',
          summary: 's',
          observedAt: '2026-10-03T00:00:00Z',
        },
      ],
      autoRules: [],
      capabilities: [],
      threadCapabilities: {},
      blueprints: [],
      network: [],
      gadgets: [],
    };
    safeWriteFile(
      path.join(legacyDir, 'control-plane.json'),
      JSON.stringify(legacyState, null, 2) + '\n',
      { encoding: 'utf8' }
    );

    const cp = new CloudflareOsControlPlane();
    expect(cp.listHeldActions('mission-j')).toHaveLength(1);
    expect(cp.listObservationAggregates('mission-j')[0]?.count).toBe(1);
    // Legacy file was consumed, not left in place.
    const namespaces = listControlPlaneNamespaceDirs(testRoot);
    expect(namespaces.some((dir) => dir.includes(path.join('confidential', 'tenant-a')))).toBe(
      true
    );
  });

  it('executes a held action after restart once its executor is registered', async () => {
    const cp1 = new CloudflareOsControlPlane();
    const record = submit(cp1);
    cp1.decideHeldAction(record.id, 'approved', {
      resolvedBy: 'human:famao',
      decidedByType: 'human',
      authenticated: true,
      payloadHash: record.payloadHash,
      effectBinding: record.effectBinding,
    });
    const cp2 = new CloudflareOsControlPlane();
    let executed: unknown;
    cp2.registerExecutor('service:create_issue', async (params) => {
      executed = params;
      return { id: 'real-1' };
    });
    const applied = await cp2.applyHeldAction(record.id);
    expect(applied.status).toBe('applied');
    expect(executed).toEqual({ title: 'x' });
  });

  it('settles a held decision via the shared approval store (SC-04)', async () => {
    const cp = new CloudflareOsControlPlane();
    const record = cp.submitHeldAction({
      missionId: 'mission-j',
      tenantSlug: 'tenant-a',
      submittedBy: 'agent:x',
      op: 'service:create_issue',
      params: { title: 'x' },
      persistParams: true,
      apply: async () => ({ ok: true }),
      steeringApproval: {
        surface: 'cli',
        channel: 'ops-channel',
        threadTs: 'thread-1',
        correlationId: 'corr-1',
        requestedBy: 'agent:x',
        title: 'Approve create_issue',
        summary: 'held effect decision',
      },
    });
    expect(record.approvalRequest?.requestId).toBeTruthy();
    const request = loadApprovalRequest(
      record.approvalRequest!.storageChannel,
      record.approvalRequest!.requestId
    );
    expect(request?.status).toBe('pending');
    expect(request?.steering?.kind).toBe('held_effect');

    // Path B: a human decides via the shared store — the bridge settles held.
    decideApprovalRequest('mission_controller', {
      channel: record.approvalRequest!.storageChannel,
      requestId: record.approvalRequest!.requestId,
      decision: 'approved',
      decidedBy: 'human:famao',
      decidedByType: 'human',
      authenticated: true,
      payloadHash: record.payloadHash,
      effectBinding: record.effectBinding,
    });
    await drainPendingSteeringApprovalExecutions();

    const cp2 = new CloudflareOsControlPlane();
    expect(cp2.getHeldAction(record.id)?.status).toBe('approved');
    let executed: unknown;
    cp2.registerExecutor('service:create_issue', async (params) => {
      executed = params;
      return { id: 'real-1' };
    });
    const applied = await cp2.applyHeldAction(record.id);
    expect(applied.status).toBe('applied');
    expect(executed).toEqual({ title: 'x' });
  });

  it('routes a linked decideHeldAction through the shared store first', () => {
    const cp = new CloudflareOsControlPlane();
    const record = cp.submitHeldAction({
      missionId: 'mission-j',
      tenantSlug: 'tenant-a',
      submittedBy: 'agent:x',
      op: 'service:create_issue',
      params: { title: 'x' },
      persistParams: true,
      apply: async () => ({ ok: true }),
      steeringApproval: {
        surface: 'cli',
        channel: 'ops-channel',
        threadTs: 'thread-2',
        correlationId: 'corr-2',
        requestedBy: 'agent:x',
        title: 'Approve create_issue',
        summary: 'held effect decision',
      },
    });
    cp.decideHeldAction(record.id, 'rejected', {
      resolvedBy: 'human:famao',
      decidedByType: 'human',
      authenticated: true,
      payloadHash: record.payloadHash,
      effectBinding: record.effectBinding,
    });
    const request = loadApprovalRequest(
      record.approvalRequest!.storageChannel,
      record.approvalRequest!.requestId
    );
    expect(request?.status).toBe('rejected');
    expect(cp.getHeldAction(record.id)?.status).toBe('rejected');
  });

  it('quarantines tenant-scoped records with no resolvable tenant', () => {
    const cp = new CloudflareOsControlPlane();
    submit(cp, { tenantSlug: undefined });
    const quarantineDir = path.join(testRoot, 'system', 'quarantine', 'cloudflare-os');
    const { events } = readJournalTail(quarantineDir, 0);
    expect(events.some((e) => e.kind === 'held')).toBe(true);
  });
});

describe('review fixes: executors, params at rest, tenant namespaces', () => {
  const approve = (
    cp: CloudflareOsControlPlane,
    record: { id: string; payloadHash: string; effectBinding: string }
  ) =>
    cp.decideHeldAction(record.id, 'approved', {
      resolvedBy: 'human:famao',
      decidedByType: 'human',
      authenticated: true,
      payloadHash: record.payloadHash,
      effectBinding: record.effectBinding,
    });
  const base = {
    missionId: 'mission-r',
    tenantSlug: 'tenant-a',
    submittedBy: 'agent:x',
    op: 'demo:write',
  };

  it('keeps the live executor and params when another process decides the same action', async () => {
    const owner = new CloudflareOsControlPlane();
    const surface = new CloudflareOsControlPlane();
    let runs = 0;
    let seen: unknown;
    const record = owner.submitHeldAction({
      ...base,
      params: { title: 'in-memory only' },
      apply: async (params) => {
        runs += 1;
        seen = params;
        return 'ok';
      },
    });
    surface.refreshFromJournals();
    approve(surface, record);
    owner.refreshFromJournals();
    const applied = await owner.applyHeldAction(record.id);
    expect(applied.status).toBe('applied');
    expect(runs).toBe(1);
    expect(seen).toEqual({ title: 'in-memory only' });
  });

  it('resolves a restored executor from the registry at apply time, even after a later catch-up', async () => {
    const owner = new CloudflareOsControlPlane();
    const surface = new CloudflareOsControlPlane();
    const record = owner.submitHeldAction({
      ...base,
      params: { n: 1 },
      persistParams: true,
      apply: async () => 'unused',
    });
    surface.refreshFromJournals();
    approve(surface, record);
    const restarted = new CloudflareOsControlPlane();
    let executed: unknown;
    restarted.registerExecutor('demo:write', async (params) => {
      executed = params;
      return 'ok';
    });
    // A catch-up replaces the record object; the registry must still win.
    restarted.refreshFromJournals();
    const applied = await restarted.applyHeldAction(record.id);
    expect(applied.status).toBe('applied');
    expect(executed).toEqual({ n: 1 });
  });

  it('does not persist params unless the submitter opts in', () => {
    const cp = new CloudflareOsControlPlane();
    cp.submitHeldAction({
      ...base,
      params: { body: 'sk-SECRET-123' },
      apply: async () => 'ok',
    });
    const dir = path.join(testRoot, 'confidential', 'tenant-a', 'cloudflare-os');
    const journal = String(safeReadFile(path.join(dir, 'journal.jsonl')));
    expect(journal).not.toContain('sk-SECRET-123');
    expect(String(safeReadFile(path.join(dir, 'snapshot.json')))).not.toContain('sk-SECRET-123');
  });

  it('defers (never runs, never poisons) when params were not persisted', async () => {
    const owner = new CloudflareOsControlPlane();
    let ownerRuns = 0;
    const record = owner.submitHeldAction({
      ...base,
      params: { body: 'x' },
      apply: async () => {
        ownerRuns += 1;
        return 'ok';
      },
    });
    approve(owner, record);
    const restarted = new CloudflareOsControlPlane();
    let restartedRuns = 0;
    restarted.registerExecutor('demo:write', async () => {
      restartedRuns += 1;
      return 'ran';
    });
    // The restarted process has an executor but no params: it must not run
    // the effect and must not mark the approval failed for the owner.
    expect((await restarted.applyHeldAction(record.id)).status).toBe('approved');
    expect(restartedRuns).toBe(0);
    // The owner process still holds the params in memory and can apply.
    owner.refreshFromJournals();
    expect((await owner.applyHeldAction(record.id)).status).toBe('applied');
    expect(ownerRuns).toBe(1);
  });

  it('rejects persistParams when params carry secret-like keys', () => {
    const cp = new CloudflareOsControlPlane();
    expect(() =>
      cp.submitHeldAction({
        ...base,
        params: { nested: { apiKey: 'k' } },
        persistParams: true,
        apply: async () => 'ok',
      })
    ).toThrow(/POLICY_VIOLATION.*persistParams/);
  });

  it('quarantines records whose tenant is a reserved or invalid scope name', () => {
    for (const tenantSlug of ['shared', 'public', 'confidential', '../x']) {
      const namespace = controlPlaneNamespaceFor('held', { tenantSlug });
      expect(namespace.quarantined).toBe(true);
    }
    expect(controlPlaneNamespaceFor('held', { tenantSlug: 'tenant-a' }).quarantined).toBe(false);
  });
});

describe('review fixes: exactly-once apply across processes', () => {
  const base = {
    missionId: 'mission-once',
    tenantSlug: 'tenant-a',
    submittedBy: 'agent:x',
    op: 'demo:pay',
    params: { amount: 1 },
    persistParams: true,
  };
  const approve = (
    cp: CloudflareOsControlPlane,
    r: { id: string; payloadHash: string; effectBinding: string }
  ) =>
    cp.decideHeldAction(r.id, 'approved', {
      resolvedBy: 'human:famao',
      decidedByType: 'human',
      authenticated: true,
      payloadHash: r.payloadHash,
      effectBinding: r.effectBinding,
    });

  it('runs an approved effect once when two processes apply it concurrently', async () => {
    let runs = 0;
    const slow = async () => {
      runs += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return 'paid';
    };
    const owner = new CloudflareOsControlPlane();
    const record = owner.submitHeldAction({ ...base, apply: slow });
    approve(owner, record);
    const other = new CloudflareOsControlPlane();
    other.registerExecutor('demo:pay', slow);

    const [a, b] = await Promise.all([
      owner.applyHeldAction(record.id),
      other.applyHeldAction(record.id),
    ]);
    expect(runs).toBe(1);
    expect([a.status, b.status].filter((status) => status === 'applied')).toHaveLength(1);
    // The loser did not run and did not mark anything failed.
    expect([a.status, b.status]).not.toContain('failed');
    expect(new CloudflareOsControlPlane().getHeldAction(record.id)?.status).toBe('applied');
  });

  it('never re-runs an effect whose claim has no recorded outcome (crash after claim)', async () => {
    let runs = 0;
    const owner = new CloudflareOsControlPlane();
    const record = owner.submitHeldAction({ ...base, apply: async () => 'unused' });
    approve(owner, record);
    // A process wins the claim and dies before recording an outcome.
    const crashed = new CloudflareOsControlPlane();
    expect(
      (
        crashed as unknown as { journalStore: { claimHeldApply(id: string, by: string): boolean } }
      ).journalStore.claimHeldApply(record.id, 'ghost:1')
    ).toBe(true);

    const later = new CloudflareOsControlPlane();
    later.registerExecutor('demo:pay', async () => {
      runs += 1;
      return 'again';
    });
    const result = await later.applyHeldAction(record.id);
    expect(runs).toBe(0);
    expect(result.status).toBe('approved');
    expect(result.applyClaim?.by).toBe('ghost:1');
  });
});

describe('review fixes: declassify grants are mission-scoped', () => {
  it('does not let one mission grant overwrite or satisfy another mission', async () => {
    const cp = new CloudflareOsControlPlane();
    const grant = async (missionId: string) => {
      const held = cp.requestDeclassify({
        missionId,
        tenantSlug: 'tenant-a',
        artifactRef: 'report:v1',
        payloadHash: 'same-hash',
        targetAudience: 'public',
        targetTenant: 'tenant-a',
        requestedBy: 'agent:x',
      });
      cp.decideHeldAction(held.id, 'approved', {
        resolvedBy: 'human:famao',
        decidedByType: 'human',
        authenticated: true,
        payloadHash: held.payloadHash,
        effectBinding: held.effectBinding,
      });
      await cp.applyHeldAction(held.id);
    };
    await grant('mission-a');
    expect(cp.isDeclassified('mission-a', 'same-hash', 'public', 'tenant-a')).toBe(true);
    expect(cp.isDeclassified('mission-b', 'same-hash', 'public', 'tenant-a')).toBe(false);
    await grant('mission-b');
    // B's grant must not erase A's.
    expect(cp.isDeclassified('mission-a', 'same-hash', 'public', 'tenant-a')).toBe(true);
    expect(cp.isDeclassified('mission-b', 'same-hash', 'public', 'tenant-a')).toBe(true);
  });
});

describe('releasing an unresolved apply claim', () => {
  const base = {
    missionId: 'mission-rel',
    tenantSlug: 'tenant-a',
    submittedBy: 'agent:x',
    op: 'demo:pay',
    params: { amount: 1 },
    persistParams: true,
  };
  const human = (r: { payloadHash: string; effectBinding: string }) => ({
    resolvedBy: 'human:famao',
    decidedByType: 'human' as const,
    authenticated: true,
    payloadHash: r.payloadHash,
    effectBinding: r.effectBinding,
  });
  const claimedRecord = () => {
    const owner = new CloudflareOsControlPlane();
    const record = owner.submitHeldAction({ ...base, apply: async () => 'unused' });
    owner.decideHeldAction(record.id, 'approved', human(record));
    // A process wins the claim and dies before recording an outcome.
    const crashed = new CloudflareOsControlPlane() as unknown as {
      journalStore: { claimHeldApply(id: string, by: string): boolean };
    };
    expect(crashed.journalStore.claimHeldApply(record.id, 'ghost:1')).toBe(true);
    return record;
  };

  it('lets an authenticated human release the claim so another process can apply once', async () => {
    const record = claimedRecord();
    let runs = 0;
    const next = new CloudflareOsControlPlane();
    next.registerExecutor('demo:pay', async () => {
      runs += 1;
      return 'paid';
    });
    expect((await next.applyHeldAction(record.id)).status).toBe('approved'); // still claimed
    const released = next.releaseApplyClaim(record.id, {
      ...human(record),
      reason: 'ghost process crashed; payment provider shows no charge',
    });
    expect(released.applyClaim).toBeUndefined();
    expect((await next.applyHeldAction(record.id)).status).toBe('applied');
    expect(runs).toBe(1);
  });

  it('refuses a release without an authenticated human, a reason, or a live claim', () => {
    const record = claimedRecord();
    const cp = new CloudflareOsControlPlane();
    expect(() =>
      cp.releaseApplyClaim(record.id, {
        ...human(record),
        decidedByType: 'ai_agent',
        reason: 'because',
      })
    ).toThrow(/authenticated human/);
    expect(() => cp.releaseApplyClaim(record.id, { ...human(record), reason: ' ' })).toThrow();
    cp.releaseApplyClaim(record.id, { ...human(record), reason: 'verified no side effect' });
    expect(() => cp.releaseApplyClaim(record.id, { ...human(record), reason: 'again' })).toThrow(
      /no releasable apply claim/
    );
  });

  it('shows the claim on the operator summary so a stuck action is visible', () => {
    const record = claimedRecord();
    const summary = new CloudflareOsControlPlane().getHeldActionSummary(record.id);
    expect(summary?.applyClaim?.by).toBe('ghost:1');
  });
});

describe('observation write cost', () => {
  const observe = (cp: CloudflareOsControlPlane, i: number) =>
    cp.recordObservation({
      missionId: 'mission-perf',
      service: 'file',
      resourceRef: `file:in/${i}.json`,
      tier: 'confidential',
      tenantSlug: 'tenant-a',
      purpose: 'p',
      summary: 's',
    });

  it('does not re-parse the whole journal for every append by the same process', () => {
    const cp = new CloudflareOsControlPlane();
    observe(cp, 0);
    const before = journalFullParseCountForTests();
    for (let i = 1; i <= 40; i += 1) observe(cp, i);
    // The journal only changes by this process's own appends: no re-parse.
    expect(journalFullParseCountForTests() - before).toBeLessThanOrEqual(1);
  });

  it('still catches up on appends made by another process', () => {
    const mine = new CloudflareOsControlPlane();
    observe(mine, 0);
    const other = new CloudflareOsControlPlane();
    observe(other, 1);
    observe(mine, 2); // must see `other`'s event before appending
    const aggregates = new CloudflareOsControlPlane().listObservationAggregates('mission-perf');
    expect(aggregates.map((entry) => entry.resourceRef).sort()).toEqual([
      'file:in/0.json',
      'file:in/1.json',
      'file:in/2.json',
    ]);
    expect(mine.listObservationAggregates('mission-perf')).toHaveLength(3);
  });

  it('refreshes the derived snapshot and rollup lazily, never losing the journal', () => {
    const cp = new CloudflareOsControlPlane();
    for (let i = 0; i < 5; i += 1) observe(cp, i);
    const dir = path.join(testRoot, 'confidential', 'tenant-a', 'cloudflare-os');
    const snapshot = JSON.parse(
      String(safeReadFile(path.join(dir, 'snapshot.json'), { encoding: 'utf8' }))
    );
    // Derived caches are not rewritten per observation…
    expect(snapshot.observations.length).toBeLessThan(5);
    // …but the journal (the source of truth) has every one, and a restart replays it.
    expect(new CloudflareOsControlPlane().listObservationAggregates('mission-perf')).toHaveLength(
      5
    );
  });
});
