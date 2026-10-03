import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeWriteFile } from './secure-io.js';
import { auditChain } from './governance/audit-chain.js';
import {
  appendJournalEventLocked,
  controlPlaneNamespaceFor,
  controlPlaneRuntimeRoot,
  controlPlaneJournalPath,
  foldObservationAggregate,
  listControlPlaneNamespaceDirs,
  readJournalTail,
  setControlPlaneRuntimeRootForTests,
  type ControlPlaneJournalEvent,
  type ObservationAggregate,
} from './cloudflare-os-journal.js';
import { CloudflareOsControlPlane } from './cloudflare-os-control-plane.js';
import { mintScopeEnvelope, withScopeEnvelope } from './scope-envelope.js';

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

  it('quarantines tenant-scoped records with no resolvable tenant', () => {
    const cp = new CloudflareOsControlPlane();
    submit(cp, { tenantSlug: undefined });
    const quarantineDir = path.join(testRoot, 'system', 'quarantine', 'cloudflare-os');
    const { events } = readJournalTail(quarantineDir, 0);
    expect(events.some((e) => e.kind === 'held')).toBe(true);
  });
});
