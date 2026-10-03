import * as path from 'node:path';
import { auditChain } from './governance/audit-chain.js';
import { getRegisteredEnvText } from './foundation/env.js';
import {
  appendJournalEventLocked,
  appendJournalEventLockedIf,
  controlPlaneNamespaceFor,
  controlPlaneRuntimeRoot,
  controlPlaneSnapshotPath,
  listControlPlaneNamespaceDirs,
  readJournalTail,
  writeObservationAggregates,
  type ControlPlaneCollection,
  type ControlPlaneJournalEvent,
  type ControlPlaneNamespace,
  type ObservationAggregate,
} from './cloudflare-os-journal.js';
import { currentScopeEnvelope } from './scope-envelope.js';
import {
  loadPersistedControlPlaneStateAtPath,
  type PersistedControlPlaneState,
} from './cloudflare-os-control-plane-state.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReadFile,
  safeUnlinkSync,
  safeWriteFile,
} from './secure-io.js';

/**
 * SC-03: the write/read journal driver for the cloudflare-os control plane.
 * The plane supplies collection-aware callbacks through
 * {@link ControlPlaneJournalHost}; this store owns sequencing, namespace
 * grouping, locked appends, migration, and replay — never the record shapes.
 */
export interface ControlPlaneJournalHost {
  /** The held record for an id in the in-memory projection. */
  heldRecord(id: string): Record<string, unknown> | undefined;
  /** Fold one journal event into the in-memory projection. */
  applyJournalEvent(event: ControlPlaneJournalEvent): void;
  /** Serializable record for a collection entry (strips executors). */
  serializedJournalRecord(kind: ControlPlaneCollection, record: unknown): Record<string, unknown>;
  /** The fully serialized projection used to build namespace snapshots. */
  serializedState(): PersistedControlPlaneState;
  /** Observation rollups belonging to a namespace. */
  observationAggregatesFor(namespace: ControlPlaneNamespace): ObservationAggregate[];
}

function audit(
  operation: string,
  result: 'allowed' | 'denied' | 'completed' | 'failed',
  metadata: Record<string, unknown>
): void {
  auditChain.record({
    agentId: getRegisteredEnvText('KYBERION_PERSONA') || 'cloudflare-os-journal-store',
    action: 'control_plane',
    operation,
    result,
    metadata,
  });
}

/** Derived caches are refreshed at most every N observations or this long. */
const DERIVED_REFRESH_EVERY = 100;
const DERIVED_REFRESH_MS = 2000;

export class ControlPlaneJournalStore {
  private readonly appliedSeq = new Map<string, number>();
  private readonly derivedRefresh = new Map<string, { count: number; at: number }>();

  /**
   * Observations are by far the most frequent mutation, and the snapshot and
   * rollup are derived caches (the journal is the source of truth and restore
   * replays it), so rewriting the whole state for each one made recording cost
   * grow with the journal. Other kinds always refresh immediately.
   */
  private shouldRefreshDerived(namespaceDir: string, kind: ControlPlaneCollection): boolean {
    if (kind !== 'observation') return true;
    const now = Date.now();
    const state = this.derivedRefresh.get(namespaceDir);
    if (
      !state ||
      state.count + 1 >= DERIVED_REFRESH_EVERY ||
      now - state.at >= DERIVED_REFRESH_MS
    ) {
      this.derivedRefresh.set(namespaceDir, { count: 0, at: now });
      return true;
    }
    state.count += 1;
    return false;
  }

  constructor(private readonly host: ControlPlaneJournalHost) {}

  /**
   * Route a mutation to the tenant-namespaced journal. Records of one kind
   * may span tenants, so they are grouped per namespace and each group runs
   * one locked append with tail catch-up.
   */
  recordMutation(kind: ControlPlaneCollection, records: unknown[]): void {
    if (records.length === 0) return;
    const envelope = currentScopeEnvelope();
    const groups = new Map<
      string,
      { namespace: ControlPlaneNamespace; records: Record<string, unknown>[] }
    >();
    for (const record of records) {
      const serialized = this.host.serializedJournalRecord(kind, record);
      const namespace = controlPlaneNamespaceFor(kind, serialized, envelope);
      const group = groups.get(namespace.key) ?? { namespace, records: [] };
      group.records.push(serialized);
      groups.set(namespace.key, group);
      if (namespace.quarantined) {
        audit('quarantine', 'completed', { kind, recordId: serialized.id });
      }
    }
    for (const group of groups.values()) {
      const seq = appendJournalEventLocked(
        group.namespace,
        this.appliedSeq.get(group.namespace.dir) ?? 0,
        { kind, records: group.records },
        (tail) => {
          for (const event of tail) this.host.applyJournalEvent(event);
        }
      );
      this.appliedSeq.set(group.namespace.dir, seq);
      if (!this.shouldRefreshDerived(group.namespace.dir, kind)) continue;
      this.writeNamespaceSnapshot(group.namespace);
      if (kind === 'observation') {
        writeObservationAggregates(
          group.namespace.dir,
          this.host.observationAggregatesFor(group.namespace)
        );
      }
    }
  }

  /**
   * Claim the single execution of an approved held action. Under the
   * namespace journal lock the projection is caught up first, then the claim
   * is appended only if the record is still `approved` and unclaimed — so of
   * any number of processes racing to apply, exactly one wins. A claim is
   * never released automatically: a crash after the claim leaves the effect's
   * outcome unknown, and re-running it could duplicate a side effect.
   */
  claimHeldApply(id: string, by: string): boolean {
    const initial = this.host.heldRecord(id);
    if (!initial) return false;
    const envelope = currentScopeEnvelope();
    const namespace = controlPlaneNamespaceFor(
      'held',
      this.host.serializedJournalRecord('held', initial),
      envelope
    );
    let won = false;
    const { seq } = appendJournalEventLockedIf(
      namespace,
      this.appliedSeq.get(namespace.dir) ?? 0,
      (tail) => {
        for (const event of tail) this.host.applyJournalEvent(event);
      },
      () => {
        const current = this.host.heldRecord(id);
        if (!current || current.status !== 'approved' || current.applyClaim) return null;
        current.applyClaim = { by, at: new Date().toISOString() };
        won = true;
        return { kind: 'held', records: [this.host.serializedJournalRecord('held', current)] };
      }
    );
    this.appliedSeq.set(namespace.dir, seq);
    if (won) this.writeNamespaceSnapshot(namespace);
    return won;
  }

  /**
   * Drop an apply claim that has no outcome (record still `approved`), under
   * the same journal lock as the claim itself. Returns whether one was dropped.
   */
  releaseHeldApplyClaim(id: string): boolean {
    const initial = this.host.heldRecord(id);
    if (!initial) return false;
    const namespace = controlPlaneNamespaceFor(
      'held',
      this.host.serializedJournalRecord('held', initial),
      currentScopeEnvelope()
    );
    let released = false;
    const { seq } = appendJournalEventLockedIf(
      namespace,
      this.appliedSeq.get(namespace.dir) ?? 0,
      (tail) => {
        for (const event of tail) this.host.applyJournalEvent(event);
      },
      () => {
        const current = this.host.heldRecord(id);
        if (!current || current.status !== 'approved' || !current.applyClaim) return null;
        delete current.applyClaim;
        released = true;
        return { kind: 'held', records: [this.host.serializedJournalRecord('held', current)] };
      }
    );
    this.appliedSeq.set(namespace.dir, seq);
    if (released) this.writeNamespaceSnapshot(namespace);
    return released;
  }

  /** Rebuild state from every namespace journal after legacy migration. */
  restore(auditRestoreFailures: boolean): void {
    try {
      this.migrateLegacyControlPlaneState();
      for (const dir of listControlPlaneNamespaceDirs()) {
        const { events, lastSeq } = readJournalTail(dir, this.appliedSeq.get(dir) ?? 0);
        for (const event of events) this.host.applyJournalEvent(event);
        this.appliedSeq.set(dir, lastSeq);
      }
      // Refresh the cache snapshots after replay so they reflect migrated data.
      for (const dir of listControlPlaneNamespaceDirs()) {
        this.writeNamespaceSnapshot({
          key: dir,
          dir,
          quarantined: dir.includes(`${path.sep}system${path.sep}quarantine${path.sep}`),
        });
      }
    } catch (error) {
      if (auditRestoreFailures) {
        audit('restore', 'failed', {
          journal: true,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Write the namespace's cache snapshot — a filtered view of the host's
   * serialized state. The journal stays the source of truth; a failed
   * snapshot write degrades to audit, never a throw.
   */
  private writeNamespaceSnapshot(namespace: ControlPlaneNamespace): void {
    try {
      const envelope = currentScopeEnvelope();
      const inNamespace = (kind: ControlPlaneCollection, record: unknown): boolean => {
        try {
          return (
            controlPlaneNamespaceFor(kind, record as Record<string, unknown>, envelope).key ===
            namespace.key
          );
        } catch {
          return false;
        }
      };
      const state = this.host.serializedState();
      const filtered: PersistedControlPlaneState = {
        version: 1,
        held: state.held.filter((record) => inNamespace('held', record)),
        introductions: state.introductions.filter((record) => inNamespace('introduction', record)),
        observations: state.observations.filter((record) => inNamespace('observation', record)),
        autoRules: state.autoRules.filter((record) => inNamespace('auto_rule', record)),
        capabilities: state.capabilities.filter((record) => inNamespace('capability', record)),
        threadCapabilities: Object.fromEntries(
          Object.entries(state.threadCapabilities)
            .map(([threadId, capabilities]) => ({ threadId, capabilities }))
            .filter((entry) => inNamespace('thread_capability', entry))
            .map((entry) => [entry.threadId, entry.capabilities])
        ),
        blueprints: state.blueprints.filter((record) => inNamespace('blueprint', record)),
        ...(state.declassifications
          ? {
              declassifications: state.declassifications.filter((record) =>
                inNamespace('declassification', record)
              ),
            }
          : {}),
        network: state.network.filter((record) => inNamespace('network', record)),
        gadgets: state.gadgets.filter((record) => inNamespace('gadget', record)),
      };
      safeWriteFile(
        controlPlaneSnapshotPath(namespace.dir),
        JSON.stringify(filtered, null, 2) + '\n',
        { encoding: 'utf8' }
      );
    } catch (error) {
      audit('snapshot', 'failed', {
        namespace: namespace.key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Catch every journal up — the read path for cross-process freshness. */
  refresh(): void {
    try {
      for (const dir of listControlPlaneNamespaceDirs()) {
        const { events, lastSeq } = readJournalTail(dir, this.appliedSeq.get(dir) ?? 0);
        for (const event of events) this.host.applyJournalEvent(event);
        this.appliedSeq.set(dir, lastSeq);
      }
    } catch {
      // Read-path refresh is best effort; the write path remains fail-closed.
    }
  }

  /**
   * One-shot migration of the legacy flat control-plane.json into the
   * tenant-namespaced journals. Tenant-scoped records without a resolvable
   * tenant are quarantined and audited — never dropped.
   */
  private migrateLegacyControlPlaneState(): void {
    const legacyPath = assertSafeRepositoryPath(
      `${controlPlaneRuntimeRoot()}/cloudflare-os/control-plane.json`,
      { allowMissingLeaf: true }
    );
    if (!safeExistsSync(legacyPath) || !safeLstat(legacyPath).isFile()) return;
    const state = loadPersistedControlPlaneStateAtPath(legacyPath);
    if (!state) return;
    const batches: Array<[ControlPlaneCollection, Record<string, unknown>[]]> = [
      ['held', (state.held ?? []) as Record<string, unknown>[]],
      ['introduction', (state.introductions ?? []) as unknown as Record<string, unknown>[]],
      ['observation', (state.observations ?? []) as unknown as Record<string, unknown>[]],
      ['auto_rule', (state.autoRules ?? []) as unknown as Record<string, unknown>[]],
      ['capability', (state.capabilities ?? []) as unknown as Record<string, unknown>[]],
      [
        'thread_capability',
        Object.entries(state.threadCapabilities ?? {}).map(([threadId, capabilities]) => ({
          threadId,
          capabilities,
        })),
      ],
      ['blueprint', (state.blueprints ?? []) as unknown as Record<string, unknown>[]],
      ['declassification', (state.declassifications ?? []) as unknown as Record<string, unknown>[]],
      ['network', (state.network ?? []) as unknown as Record<string, unknown>[]],
      ['gadget', (state.gadgets ?? []) as unknown as Record<string, unknown>[]],
    ];
    let migrated = 0;
    let quarantined = 0;
    for (const [kind, records] of batches) {
      if (!records?.length) continue;
      const groups = new Map<
        string,
        { namespace: ControlPlaneNamespace; records: Record<string, unknown>[] }
      >();
      for (const record of records) {
        const namespace = controlPlaneNamespaceFor(kind, record, currentScopeEnvelope());
        const group = groups.get(namespace.key) ?? { namespace, records: [] };
        group.records.push(record);
        groups.set(namespace.key, group);
        if (namespace.quarantined) quarantined += 1;
      }
      for (const group of groups.values()) {
        // The migration appends only — restore() replays these events into
        // memory right after, so appliedSeq stays untouched here.
        appendJournalEventLocked(
          group.namespace,
          this.appliedSeq.get(group.namespace.dir) ?? 0,
          { kind, records: group.records },
          (tail) => {
            for (const event of tail) this.host.applyJournalEvent(event);
          }
        );
        migrated += group.records.length;
      }
    }
    const migratedPath = `${legacyPath}.migrated`;
    safeWriteFile(migratedPath, safeReadFile(legacyPath, { encoding: 'utf8' }) || '', {
      encoding: 'utf8',
    });
    safeUnlinkSync(legacyPath);
    audit('migrate', 'completed', { migrated, quarantined, legacyPath });
  }
}
