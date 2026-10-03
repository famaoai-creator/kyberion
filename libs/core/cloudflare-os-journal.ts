import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { nowIso } from './foundation/time.js';
import { withLockSync } from './foundation/lock-utils.js';
import { appendJsonLine, readJsonLines } from './foundation/json.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReaddir,
  safeStat,
  safeWriteFile,
} from './secure-io.js';
import type { TierLevel } from './types.js';
import { isValidTenantSlug } from './entity-scope.js';
import { currentScopeEnvelope, type ScopeEnvelope } from './scope-envelope.js';
import type { ObservationRecord } from './cloudflare-os-control-plane.js';

/**
 * SC-03: append-only journal for the cloudflare-os control plane.
 *
 * One JSONL event per line; the journal is the source of truth and the
 * snapshot is a rebuildable cache. Every write runs under `withLockSync` and
 * first catches the in-memory state up to the journal tail, so concurrent
 * processes can no longer lose each other's mutations.
 *
 * Storage is tenant-namespaced: `active/shared/runtime/<tier>/<tenant|shared>/
 * cloudflare-os/`. Tenant identity is resolved at write time from the
 * SC-01 envelope when one is active, otherwise from the record itself.
 * Records whose tenant cannot be resolved are quarantined under
 * `runtime/system/quarantine/cloudflare-os/` — held inert and audited, never
 * discarded, and never served as tenant data.
 */

export type ControlPlaneCollection =
  | 'held'
  | 'introduction'
  | 'observation'
  | 'auto_rule'
  | 'capability'
  | 'thread_capability'
  | 'blueprint'
  | 'network'
  | 'gadget'
  | 'declassification';

/** Collections that grow by appending rather than keyed upsert. */
export const APPEND_COLLECTIONS: ReadonlySet<ControlPlaneCollection> = new Set([
  'observation',
  'auto_rule',
  'network',
]);

/** Collections that carry tenant scope and must never land in shared space. */
const TENANT_SCOPED_COLLECTIONS: ReadonlySet<ControlPlaneCollection> = new Set([
  'held',
  'introduction',
  'observation',
]);

export interface ControlPlaneJournalEvent {
  seq: number;
  ts: string;
  kind: ControlPlaneCollection;
  /** `delete` is a tombstone: it removes a still-unscoped record that was re-homed elsewhere. */
  op: 'upsert' | 'append' | 'delete';
  records: Record<string, unknown>[];
}

export interface ControlPlaneNamespace {
  /** Partition key: `<tier>/<tenant|shared>` or `system/quarantine`. */
  key: string;
  /** Absolute path of the `cloudflare-os/` namespace directory. */
  dir: string;
  quarantined: boolean;
}

export const CONTROL_PLANE_DOMAIN = 'cloudflare-os';
export const CONTROL_PLANE_JOURNAL_FILE = 'journal.jsonl';
export const CONTROL_PLANE_SNAPSHOT_FILE = 'snapshot.json';
export const CONTROL_PLANE_AGGREGATES_FILE = 'observation-aggregates.json';

const QUARANTINE_KEY = 'system/quarantine';
const TIER_VALUES = new Set<TierLevel>(['public', 'confidential', 'personal']);

let runtimeRootOverride: string | undefined;

/** Test seam: point the control-plane journal at an isolated runtime root. */
export function setControlPlaneRuntimeRootForTests(dir: string | undefined): void {
  runtimeRootOverride = dir ? assertSafeRepositoryPath(dir, { allowMissingLeaf: true }) : dir;
}

/** The runtime/ root all cloudflare-os namespaces resolve under. */
export function controlPlaneRuntimeRoot(): string {
  return runtimeRootOverride ?? path.join(pathResolver.rootDir(), 'active/shared/runtime');
}

function runtimeDir(...segments: string[]): string {
  return assertSafeRepositoryPath(path.join(controlPlaneRuntimeRoot(), ...segments), {
    allowMissingLeaf: true,
  });
}

function tierOf(value: unknown, fallback: TierLevel): TierLevel {
  return typeof value === 'string' && TIER_VALUES.has(value as TierLevel)
    ? (value as TierLevel)
    : fallback;
}

function textOf(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Resolve the namespace a record belongs to. `envelope` (the SC-01 identity
 * snapshot, when one is active) wins for tenant scoping; the record's own
 * fields are the fallback so pre-envelope writers still land correctly.
 * Tenant-scoped collections with no resolvable tenant go to quarantine.
 */
export function controlPlaneNamespaceFor(
  kind: ControlPlaneCollection,
  record: Record<string, unknown>,
  envelope?: ScopeEnvelope
): ControlPlaneNamespace {
  const activeEnvelope = envelope ?? currentScopeEnvelope();
  const recordTenant = textOf(record, 'tenantSlug', 'tenant_slug');
  const envelopeTenant = activeEnvelope?.identity.tenant_slug;
  const recordTier = tierOf(record.tier, activeEnvelope?.identity.tier ?? 'confidential');
  // A record claiming a different tenant than the minted envelope cannot be
  // routed safely — quarantine it rather than misfile under either tenant.
  const contradicted = Boolean(recordTenant && envelopeTenant && recordTenant !== envelopeTenant);
  const candidate = contradicted ? undefined : (envelopeTenant ?? recordTenant);
  // Tier and partition names (`shared`, `system`, `public`, …) are never
  // tenants, and a slug is a path segment: anything that is not a valid
  // tenant slug is unresolvable, never filed under a directory of that name.
  const invalidTenant = Boolean(candidate && !isValidTenantSlug(candidate));
  const tenant = invalidTenant ? undefined : candidate;

  if (!tenant || contradicted || invalidTenant) {
    if (TENANT_SCOPED_COLLECTIONS.has(kind)) {
      return {
        key: QUARANTINE_KEY,
        dir: runtimeDir('system', 'quarantine', CONTROL_PLANE_DOMAIN),
        quarantined: true,
      };
    }
    return {
      key: `${recordTier}/shared`,
      dir: runtimeDir(recordTier, 'shared', CONTROL_PLANE_DOMAIN),
      quarantined: false,
    };
  }
  return {
    key: `${recordTier}/${tenant}`,
    dir: runtimeDir(recordTier, tenant, CONTROL_PLANE_DOMAIN),
    quarantined: false,
  };
}

export function controlPlaneJournalPath(dir: string): string {
  return path.join(dir, CONTROL_PLANE_JOURNAL_FILE);
}

export function controlPlaneSnapshotPath(dir: string): string {
  return path.join(dir, CONTROL_PLANE_SNAPSHOT_FILE);
}

export function controlPlaneAggregatesPath(dir: string): string {
  return path.join(dir, CONTROL_PLANE_AGGREGATES_FILE);
}

/**
 * What this process last saw of each journal file. A journal that has not
 * changed since (same size and mtime — i.e. only this process's own appends,
 * which refresh the entry) has nothing new to catch up on, so the whole-file
 * parse is skipped. Without this every append re-parsed the entire journal and
 * the cost of recording an observation grew with the journal.
 */
const tailCache = new Map<string, { size: number; mtimeMs: number; lastSeq: number }>();
let fullParseCount = 0;

/** Test seam: how many whole-journal parses this process has done. */
export function journalFullParseCountForTests(): number {
  return fullParseCount;
}

function noteJournalState(journalPath: string, lastSeq: number): void {
  try {
    const stat = safeStat(journalPath);
    tailCache.set(journalPath, { size: stat.size, mtimeMs: stat.mtimeMs, lastSeq });
  } catch {
    tailCache.delete(journalPath);
  }
}

/** Append one event, starting with a newline so a crash-truncated last line cannot swallow it. */
function appendJournalLine(journalPath: string, event: ControlPlaneJournalEvent): void {
  appendJsonLine(journalPath, event, { leadingNewline: true });
}

/** Read journal events with seq > afterSeq; also returns the max seq seen. */
export function readJournalTail(
  dir: string,
  afterSeq: number
): { events: ControlPlaneJournalEvent[]; lastSeq: number } {
  const journalPath = controlPlaneJournalPath(dir);
  if (!safeExistsSync(journalPath) || !safeLstat(journalPath).isFile()) {
    tailCache.delete(journalPath);
    return { events: [], lastSeq: 0 };
  }
  const known = tailCache.get(journalPath);
  if (known && afterSeq >= known.lastSeq) {
    const stat = safeStat(journalPath);
    if (stat.size === known.size && stat.mtimeMs === known.mtimeMs) {
      return { events: [], lastSeq: known.lastSeq };
    }
  }
  fullParseCount += 1;
  const lines = readJsonLines<ControlPlaneJournalEvent>(journalPath, {
    onMalformed: 'skip',
  });
  const events: ControlPlaneJournalEvent[] = [];
  let lastSeq = afterSeq;
  for (const event of lines) {
    if (!event || typeof event !== 'object') continue;
    if (typeof event.seq === 'number') lastSeq = Math.max(lastSeq, event.seq);
    if (typeof event.seq === 'number' && event.seq > afterSeq) events.push(event);
  }
  noteJournalState(journalPath, lastSeq);
  return { events, lastSeq };
}

/**
 * Locked append with tail catch-up: under the journal lock, the caller first
 * receives events newer than `afterSeq` (to merge into memory), then the new
 * event is appended. Serialized by withLockSync so multi-process writers
 * cannot interleave a read-modify-append.
 */
export function appendJournalEventLocked(
  namespace: ControlPlaneNamespace,
  afterSeq: number,
  event: {
    kind: ControlPlaneCollection;
    records: Record<string, unknown>[];
    op?: ControlPlaneJournalEvent['op'];
  },
  applyTail: (events: ControlPlaneJournalEvent[]) => void
): number {
  return withLockSync(`cloudflare-os-journal:${namespace.key}`, () => {
    safeMkdir(namespace.dir, { recursive: true });
    const { events: tail, lastSeq } = readJournalTail(namespace.dir, afterSeq);
    if (tail.length > 0) applyTail(tail);
    const seq = lastSeq + 1;
    const line: ControlPlaneJournalEvent = {
      seq,
      ts: nowIso(),
      kind: event.kind,
      op: event.op ?? (APPEND_COLLECTIONS.has(event.kind) ? 'append' : 'upsert'),
      records: event.records,
    };
    appendJournalLine(controlPlaneJournalPath(namespace.dir), line);
    noteJournalState(controlPlaneJournalPath(namespace.dir), seq);
    return seq;
  });
}

/**
 * Compare-and-append: under the same journal lock, catch the caller up to the
 * tail first, then let `build` inspect the caught-up state and decide whether
 * to append. Returns whether an event was appended and the journal's last seq.
 * This is the primitive for decisions that must not race across processes
 * (e.g. claiming the single execution of an approved effect).
 */
export function appendJournalEventLockedIf(
  namespace: ControlPlaneNamespace,
  afterSeq: number,
  applyTail: (events: ControlPlaneJournalEvent[]) => void,
  build: () => { kind: ControlPlaneCollection; records: Record<string, unknown>[] } | null
): { appended: boolean; seq: number } {
  return withLockSync(`cloudflare-os-journal:${namespace.key}`, () => {
    safeMkdir(namespace.dir, { recursive: true });
    const { events: tail, lastSeq } = readJournalTail(namespace.dir, afterSeq);
    if (tail.length > 0) applyTail(tail);
    const event = build();
    if (!event) return { appended: false, seq: lastSeq };
    const seq = lastSeq + 1;
    const line: ControlPlaneJournalEvent = {
      seq,
      ts: nowIso(),
      kind: event.kind,
      op: APPEND_COLLECTIONS.has(event.kind) ? 'append' : 'upsert',
      records: event.records,
    };
    appendJournalLine(controlPlaneJournalPath(namespace.dir), line);
    noteJournalState(controlPlaneJournalPath(namespace.dir), seq);
    return { appended: true, seq };
  });
}

/** Discover every existing cloudflare-os namespace dir under runtime/. */
export function listControlPlaneNamespaceDirs(runtimeRoot?: string): string[] {
  const root = runtimeRoot ?? controlPlaneRuntimeRoot();
  const dirs: string[] = [];
  const candidates: string[][] = [];
  for (const tier of ['public', 'confidential', 'personal']) {
    const tierDir = path.join(root, tier);
    if (!safeExistsSync(tierDir)) continue;
    for (const tenant of readdirEntries(tierDir)) {
      candidates.push([tier, tenant]);
    }
  }
  const quarantineDir = path.join(root, 'system', 'quarantine', CONTROL_PLANE_DOMAIN);
  if (safeExistsSync(controlPlaneJournalPath(quarantineDir))) dirs.push(quarantineDir);
  for (const segments of candidates) {
    const dir = path.join(root, ...segments, CONTROL_PLANE_DOMAIN);
    if (safeExistsSync(controlPlaneJournalPath(dir))) dirs.push(dir);
  }
  return dirs;
}

function readdirEntries(dir: string): string[] {
  try {
    if (!safeExistsSync(dir)) return [];
    return safeReaddir(dir).filter((entry) => {
      try {
        return safeLstat(path.join(dir, entry)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/** Derived observation rollup: mission × resource_ref × tier. */
export interface ObservationAggregate {
  missionId: string;
  resourceRef: string;
  tier: string;
  tenantSlug?: string;
  count: number;
  firstObservedAt: string;
  lastObservedAt: string;
}

export function observationAggregateKey(record: ObservationRecord): string {
  return `${record.missionId}|${record.resourceRef}|${record.tier}`;
}

export function foldObservationAggregate(
  aggregates: Map<string, ObservationAggregate>,
  record: ObservationRecord
): void {
  const key = observationAggregateKey(record);
  const existing = aggregates.get(key);
  if (existing) {
    existing.count += 1;
    if (record.observedAt < existing.firstObservedAt) existing.firstObservedAt = record.observedAt;
    if (record.observedAt > existing.lastObservedAt) existing.lastObservedAt = record.observedAt;
    if (!existing.tenantSlug && record.tenantSlug) existing.tenantSlug = record.tenantSlug;
    return;
  }
  aggregates.set(key, {
    missionId: record.missionId,
    resourceRef: record.resourceRef,
    tier: record.tier,
    ...(record.tenantSlug ? { tenantSlug: record.tenantSlug } : {}),
    count: 1,
    firstObservedAt: record.observedAt,
    lastObservedAt: record.observedAt,
  });
}

export function writeObservationAggregates(dir: string, aggregates: ObservationAggregate[]): void {
  safeMkdir(dir, { recursive: true });
  safeWriteFile(
    controlPlaneAggregatesPath(dir),
    JSON.stringify({ version: 1, aggregates }, null, 2) + '\n',
    { encoding: 'utf8' }
  );
}
