/**
 * PI-16: fencing-token writer lease for durable single-writer resources.
 *
 * The lease record is deliberately small and durable. Acquisition and the
 * protected write share one inter-process lock, so a second owner cannot
 * acquire a newer fence while the current writer is inside its callback.
 * Corrupt lease state is rejected rather than guessed or overwritten.
 */

import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { defineCatalog, type GovernedCatalog } from './foundation/governed-catalog.js';
import * as pathResolver from './path-resolver.js';
import { assertSafeRepositoryPath, safeMkdir, safeWriteFile } from './secure-io.js';
import {
  resolveLeaseBackend,
  type FencedLeaseRecord,
  type LeaseBackend,
} from './lease/lease-backend.js';
import './lease/local-lease-backend.js';

export type FencedWriterLease = FencedLeaseRecord;

export type WriterLeaseEvent =
  | { type: 'acquired'; lease: FencedWriterLease }
  | { type: 'renewed'; lease: FencedWriterLease }
  | { type: 'released'; lease: FencedWriterLease }
  | { type: 'rejected'; resourceId: string; reason: string };

export interface WriterLeaseMetricsSnapshot {
  resource_id: string;
  acquired: number;
  renewed: number;
  released: number;
  rejected: number;
}

const WRITER_LEASE_METRICS_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/writer-lease-metrics.schema.json'
);
const writerLeaseMetricsCatalogs = new Map<
  string,
  GovernedCatalog<Record<string, WriterLeaseMetricsSnapshot>>
>();

function writerLeaseMetricsCatalog(
  metricsPath: string
): GovernedCatalog<Record<string, WriterLeaseMetricsSnapshot>> {
  const existing = writerLeaseMetricsCatalogs.get(metricsPath);
  if (existing) return existing;
  const catalog = defineCatalog<Record<string, WriterLeaseMetricsSnapshot>>({
    id: 'writer-lease-metrics',
    path: metricsPath,
    schema: WRITER_LEASE_METRICS_SCHEMA_PATH,
    fallback: {},
    fallbackOnInvalid: true,
  });
  writerLeaseMetricsCatalogs.set(metricsPath, catalog);
  return catalog;
}

const writerLeaseMetrics = new Map<string, WriterLeaseMetricsSnapshot>();

export function writerLeaseMetricsPath(leasePath: string): string {
  const safeLeasePath = assertSafeRepositoryPath(leasePath, { allowMissingLeaf: true });
  return assertSafeRepositoryPath(
    path.join(path.dirname(safeLeasePath), 'writer-lease-metrics.json'),
    {
      allowMissingLeaf: true,
    }
  );
}

function observeWriterLeaseMetric(event: WriterLeaseEvent, metricsPath?: string): void {
  const resourceId = event.type === 'rejected' ? event.resourceId : event.lease.resource_id;
  const snapshot = writerLeaseMetrics.get(resourceId) ?? {
    resource_id: resourceId,
    acquired: 0,
    renewed: 0,
    released: 0,
    rejected: 0,
  };
  snapshot[event.type] += 1;
  writerLeaseMetrics.set(resourceId, snapshot);
  if (!metricsPath) return;
  try {
    const safeMetricsPath = assertSafeRepositoryPath(metricsPath, { allowMissingLeaf: true });
    const catalog = writerLeaseMetricsCatalog(safeMetricsPath);
    const current = catalog.load();
    const durable = current[resourceId] ?? {
      resource_id: resourceId,
      acquired: 0,
      renewed: 0,
      released: 0,
      rejected: 0,
    };
    durable[event.type] += 1;
    current[resourceId] = durable;
    safeMkdir(path.dirname(safeMetricsPath), { recursive: true });
    safeWriteFile(safeMetricsPath, `${JSON.stringify(current, null, 2)}\n`);
    catalog.reset();
  } catch {
    // Metrics are best effort and must never alter lease safety.
  }
}

/** Return process-wide lease lifecycle counts without exposing lease contents. */
export function getWriterLeaseMetrics(resourceId?: string): WriterLeaseMetricsSnapshot[] {
  const snapshots = resourceId
    ? [writerLeaseMetrics.get(resourceId)].filter(
        (snapshot): snapshot is WriterLeaseMetricsSnapshot => Boolean(snapshot)
      )
    : [...writerLeaseMetrics.values()];
  return snapshots.map((snapshot) => ({ ...snapshot }));
}

/** Read the durable aggregate written while the corresponding lease lock was held. */
export function loadWriterLeaseMetrics(
  metricsPath: string,
  resourceId?: string
): WriterLeaseMetricsSnapshot[] {
  try {
    const safeMetricsPath = assertSafeRepositoryPath(metricsPath, { allowMissingLeaf: true });
    const parsed = writerLeaseMetricsCatalog(safeMetricsPath).load();
    const snapshots = resourceId ? [parsed[resourceId]] : Object.values(parsed);
    return snapshots
      .filter((snapshot): snapshot is WriterLeaseMetricsSnapshot => Boolean(snapshot))
      .map((snapshot) => ({ ...snapshot }));
  } catch {
    return [];
  }
}

/** Test/hot-reload seam for the process-wide aggregate. */
export function resetWriterLeaseMetrics(): void {
  writerLeaseMetrics.clear();
}

export interface WithFencedWriterLeaseOptions<T> {
  resourceId: string;
  ownerId: string;
  leasePath: string;
  /** Lease duration; short by default so abandoned writers expire promptly. */
  ttlMs?: number;
  /** Renew while the callback is running; omit to require explicit renewal. */
  renewEveryMs?: number;
  nowMs?: () => number;
  onEvent?: (event: WriterLeaseEvent) => void;
  /** Persistence/exclusion backend. Defaults to the governed seam resolution (local-file-lock). */
  backend?: LeaseBackend;
  fn: (lease: FencedWriterLease) => Promise<T> | T;
}

export type WithFencedWriterLeaseSyncOptions<T> = Omit<WithFencedWriterLeaseOptions<T>, 'fn'> & {
  fn: (lease: FencedWriterLease) => T;
  /**
   * Runs the lease record IO and `fn` inside the held lock — a store's narrow
   * IO scope — while the inter-process lock itself stays under the caller.
   */
  withinLock?: <R>(run: () => R) => R;
};

export interface RenewFencedWriterLeaseOptions {
  resourceId: string;
  ownerId: string;
  leasePath: string;
  lease: FencedWriterLease;
  ttlMs?: number;
  nowMs?: () => number;
  onEvent?: (event: WriterLeaseEvent) => void;
  /** Persistence/exclusion backend. Defaults to the governed seam resolution (local-file-lock). */
  backend?: LeaseBackend;
}

function leaseLockId(resourceId: string): string {
  return `writer-lease-${resourceId}`;
}

/** Stable lock namespace derived from the actual durable lease path. */
export function writerLeaseResourceId(leasePath: string): string {
  return `path:${crypto.createHash('sha256').update(path.resolve(leasePath)).digest('hex')}`;
}

/** Read a coherent resource snapshot without changing its fence or lease metrics. */
export function withWriterLeaseSnapshotSync<T>(
  leasePath: string,
  read: () => T,
  backend?: LeaseBackend
): T {
  const resolved = backend ?? resolveLeaseBackend();
  const safePath = assertSafeRepositoryPath(leasePath, { allowMissingLeaf: true });
  return resolved.withLockSync(leaseLockId(writerLeaseResourceId(safePath)), read);
}

function readLease(leasePath: string, backend: LeaseBackend): FencedWriterLease | undefined {
  try {
    return backend.read(leasePath);
  } catch (error) {
    // Path-safety rejections carry their own tags and must propagate verbatim,
    // exactly as they did when the safe-path checks ran before the read.
    if (error instanceof Error && error.message.startsWith('[RESOURCE_PATH_')) throw error;
    if (error instanceof Error && error.message.startsWith('Invalid catalog writer-lease')) {
      throw new Error(`[WRITER_LEASE_CORRUPT] invalid lease: ${leasePath}`);
    }
    throw new Error(`[WRITER_LEASE_CORRUPT] unreadable lease: ${leasePath}`);
  }
}

function writeLease(leasePath: string, lease: FencedWriterLease, backend: LeaseBackend): void {
  backend.write(leasePath, lease);
}

function validateLeaseOptions(
  options: Pick<
    WithFencedWriterLeaseOptions<unknown>,
    'resourceId' | 'ownerId' | 'leasePath' | 'ttlMs'
  >
): { resourceId: string; ownerId: string; ttlMs: number } {
  const resourceId = options.resourceId.trim();
  const ownerId = options.ownerId.trim();
  if (!resourceId) throw new Error('[WRITER_LEASE] resourceId is required');
  if (!ownerId) throw new Error('[WRITER_LEASE] ownerId is required');
  if (!options.leasePath.trim()) throw new Error('[WRITER_LEASE] leasePath is required');
  const ttlMs = options.ttlMs ?? 30_000;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0)
    throw new Error('[WRITER_LEASE] ttlMs must be positive');
  return { resourceId, ownerId, ttlMs };
}

function validateRenewalInterval(renewEveryMs: number | undefined, ttlMs: number): void {
  if (renewEveryMs === undefined) return;
  if (!Number.isFinite(renewEveryMs) || renewEveryMs <= 0 || renewEveryMs >= ttlMs) {
    throw new Error('[WRITER_LEASE] renewEveryMs must be positive and less than ttlMs');
  }
}

function assertLeaseIdentity(options: RenewFencedWriterLeaseOptions): void {
  if (
    options.lease.resource_id !== options.resourceId ||
    options.lease.owner_id !== options.ownerId
  ) {
    throw new Error('[WRITER_LEASE] renewal token identity does not match requested owner');
  }
}

/** Observability must never prevent the protected write from being released. */
function emitEvent(
  onEvent: ((event: WriterLeaseEvent) => void) | undefined,
  event: WriterLeaseEvent,
  leasePath?: string,
  backend?: LeaseBackend
): void {
  const metricsPath = leasePath ? (backend?.metricsPath?.(leasePath) ?? undefined) : undefined;
  observeWriterLeaseMetric(event, metricsPath);
  try {
    onEvent?.(event);
  } catch {
    // Best effort only; lease safety is enforced by the durable record.
  }
}

/** Extend a live fenced lease without changing its fence. The caller holds the lease lock. */
async function renewFencedWriterLeaseUnderLock(
  options: RenewFencedWriterLeaseOptions
): Promise<FencedWriterLease> {
  const { resourceId, ownerId, ttlMs } = validateLeaseOptions(options);
  const backend = options.backend ?? resolveLeaseBackend();
  assertLeaseIdentity(options);
  const now = options.nowMs ?? (() => Date.now());
  const nowMs = now();
  const current = readLease(options.leasePath, backend);
  if (
    !current ||
    current.resource_id !== resourceId ||
    current.owner_id !== ownerId ||
    current.fence !== options.lease.fence ||
    current.expires_at_ms <= nowMs
  ) {
    emitEvent(
      options.onEvent,
      {
        type: 'rejected',
        resourceId,
        reason: 'renewal token is stale or expired',
      },
      options.leasePath,
      backend
    );
    throw new Error(
      `[WRITER_LEASE_FENCED] renewal rejected for ${resourceId} (owner=${ownerId}, fence=${options.lease.fence})`
    );
  }
  const renewed = { ...current, expires_at_ms: nowMs + ttlMs };
  writeLease(options.leasePath, renewed, backend);
  assertFencedWriterLease(options.leasePath, renewed, now(), backend);
  emitEvent(options.onEvent, { type: 'renewed', lease: renewed }, options.leasePath, backend);
  return renewed;
}

export async function renewFencedWriterLease(
  options: RenewFencedWriterLeaseOptions
): Promise<FencedWriterLease> {
  const { resourceId } = validateLeaseOptions(options);
  const backend = options.backend ?? resolveLeaseBackend();
  return backend.withLock(leaseLockId(resourceId), () => renewFencedWriterLeaseUnderLock(options));
}

/** Synchronous counterpart to renewFencedWriterLease. */
function renewFencedWriterLeaseSyncUnderLock(
  options: RenewFencedWriterLeaseOptions
): FencedWriterLease {
  const { resourceId, ownerId, ttlMs } = validateLeaseOptions(options);
  const backend = options.backend ?? resolveLeaseBackend();
  assertLeaseIdentity(options);
  const now = options.nowMs ?? (() => Date.now());
  const nowMs = now();
  const current = readLease(options.leasePath, backend);
  if (
    !current ||
    current.resource_id !== resourceId ||
    current.owner_id !== ownerId ||
    current.fence !== options.lease.fence ||
    current.expires_at_ms <= nowMs
  ) {
    emitEvent(
      options.onEvent,
      {
        type: 'rejected',
        resourceId,
        reason: 'renewal token is stale or expired',
      },
      options.leasePath,
      backend
    );
    throw new Error(
      `[WRITER_LEASE_FENCED] renewal rejected for ${resourceId} (owner=${ownerId}, fence=${options.lease.fence})`
    );
  }
  const renewed = { ...current, expires_at_ms: nowMs + ttlMs };
  writeLease(options.leasePath, renewed, backend);
  assertFencedWriterLease(options.leasePath, renewed, now(), backend);
  emitEvent(options.onEvent, { type: 'renewed', lease: renewed }, options.leasePath, backend);
  return renewed;
}

export function renewFencedWriterLeaseSync(
  options: RenewFencedWriterLeaseOptions
): FencedWriterLease {
  const { resourceId } = validateLeaseOptions(options);
  const backend = options.backend ?? resolveLeaseBackend();
  return backend.withLockSync(leaseLockId(resourceId), () =>
    renewFencedWriterLeaseSyncUnderLock(options)
  );
}

/** Reject a writer token that no longer owns the current fence. */
export function assertFencedWriterLease(
  leasePath: string,
  expected: FencedWriterLease,
  nowMs: number,
  backend?: LeaseBackend
): void {
  const current = readLease(leasePath, backend ?? resolveLeaseBackend());
  if (
    !current ||
    current.resource_id !== expected.resource_id ||
    current.owner_id !== expected.owner_id ||
    current.fence !== expected.fence ||
    current.expires_at_ms <= nowMs
  ) {
    throw new Error(
      `[WRITER_LEASE_FENCED] stale writer rejected for ${expected.resource_id} (owner=${expected.owner_id}, fence=${expected.fence})`
    );
  }
}

/** Run one protected write under an owner/fence lease. */
export async function withFencedWriterLease<T>(
  options: WithFencedWriterLeaseOptions<T>
): Promise<T> {
  const { resourceId, ownerId, ttlMs } = validateLeaseOptions(options);
  validateRenewalInterval(options.renewEveryMs, ttlMs);
  const now = options.nowMs ?? (() => Date.now());
  const backend = options.backend ?? resolveLeaseBackend();

  return backend.withLock(leaseLockId(resourceId), async () => {
    const current = readLease(options.leasePath, backend);
    const nowMs = now();
    if (current && current.expires_at_ms > nowMs) {
      emitEvent(
        options.onEvent,
        { type: 'rejected', resourceId, reason: 'live lease held by another owner' },
        options.leasePath,
        backend
      );
      throw new Error(
        `[WRITER_LEASE_BUSY] ${resourceId} is held by owner=${current.owner_id}, fence=${current.fence}`
      );
    }
    const lease: FencedWriterLease = {
      resource_id: resourceId,
      owner_id: ownerId,
      fence: (current?.fence ?? 0) + 1,
      expires_at_ms: nowMs + ttlMs,
    };
    writeLease(options.leasePath, lease, backend);
    assertFencedWriterLease(options.leasePath, lease, now(), backend);
    emitEvent(options.onEvent, { type: 'acquired', lease }, options.leasePath, backend);
    let renewalInFlight: Promise<unknown> | undefined;
    let renewalError: unknown;
    const renewalTimer =
      options.renewEveryMs === undefined
        ? undefined
        : setInterval(() => {
            if (renewalInFlight) return;
            renewalInFlight = renewFencedWriterLeaseUnderLock({
              resourceId,
              ownerId,
              leasePath: options.leasePath,
              lease,
              ttlMs,
              nowMs: now,
              onEvent: options.onEvent,
              backend,
            }).catch((error: unknown) => {
              renewalError = error;
            });
            void renewalInFlight
              .finally(() => {
                renewalInFlight = undefined;
              })
              .catch(() => undefined);
          }, options.renewEveryMs);
    try {
      const result = await options.fn(lease);
      if (renewalError) throw renewalError;
      assertFencedWriterLease(options.leasePath, lease, now(), backend);
      return result;
    } finally {
      if (renewalTimer) clearInterval(renewalTimer);
      // Preserve the fence so any writer holding an older token can never be
      // mistaken for the current owner after this lease is released.
      const latest = readLease(options.leasePath, backend);
      if (
        latest &&
        latest.resource_id === lease.resource_id &&
        latest.owner_id === lease.owner_id &&
        latest.fence === lease.fence
      ) {
        writeLease(options.leasePath, { ...lease, expires_at_ms: 0 }, backend);
        emitEvent(
          options.onEvent,
          { type: 'released', lease: { ...lease, expires_at_ms: 0 } },
          options.leasePath,
          backend
        );
      }
    }
  });
}

/** Synchronous counterpart for JSONL/trace callbacks that cannot await. */
export function withFencedWriterLeaseSync<T>(options: WithFencedWriterLeaseSyncOptions<T>): T {
  const { resourceId, ownerId, ttlMs } = validateLeaseOptions(options);
  validateRenewalInterval(options.renewEveryMs, ttlMs);
  const now = options.nowMs ?? (() => Date.now());
  const backend = options.backend ?? resolveLeaseBackend();

  const underLock = (): T => {
    const current = readLease(options.leasePath, backend);
    const nowMs = now();
    if (current && current.expires_at_ms > nowMs) {
      emitEvent(
        options.onEvent,
        { type: 'rejected', resourceId, reason: 'live lease held by another owner' },
        options.leasePath,
        backend
      );
      throw new Error(
        `[WRITER_LEASE_BUSY] ${resourceId} is held by owner=${current.owner_id}, fence=${current.fence}`
      );
    }
    const lease: FencedWriterLease = {
      resource_id: resourceId,
      owner_id: ownerId,
      fence: (current?.fence ?? 0) + 1,
      expires_at_ms: nowMs + ttlMs,
    };
    writeLease(options.leasePath, lease, backend);
    assertFencedWriterLease(options.leasePath, lease, now(), backend);
    emitEvent(options.onEvent, { type: 'acquired', lease }, options.leasePath, backend);
    try {
      const result = options.fn(lease);
      assertFencedWriterLease(options.leasePath, lease, now(), backend);
      return result;
    } finally {
      const latest = readLease(options.leasePath, backend);
      if (
        latest &&
        latest.resource_id === lease.resource_id &&
        latest.owner_id === lease.owner_id &&
        latest.fence === lease.fence
      ) {
        writeLease(options.leasePath, { ...lease, expires_at_ms: 0 }, backend);
        emitEvent(
          options.onEvent,
          { type: 'released', lease: { ...lease, expires_at_ms: 0 } },
          options.leasePath,
          backend
        );
      }
    }
  };
  const withinLock = options.withinLock ?? ((run: () => T): T => run());
  return backend.withLockSync(leaseLockId(resourceId), () => withinLock(underLock));
}
