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
import { readJson } from './foundation/json.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeWriteFile } from './secure-io.js';
import { withLock, withLockSync } from './src/lock-utils.js';

export interface FencedWriterLease {
  resource_id: string;
  owner_id: string;
  fence: number;
  expires_at_ms: number;
}

export type WriterLeaseEvent =
  | { type: 'acquired'; lease: FencedWriterLease }
  | { type: 'renewed'; lease: FencedWriterLease }
  | { type: 'released'; lease: FencedWriterLease }
  | { type: 'rejected'; resourceId: string; reason: string };

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
  fn: (lease: FencedWriterLease) => Promise<T> | T;
}

export type WithFencedWriterLeaseSyncOptions<T> = Omit<WithFencedWriterLeaseOptions<T>, 'fn'> & {
  fn: (lease: FencedWriterLease) => T;
};

export interface RenewFencedWriterLeaseOptions {
  resourceId: string;
  ownerId: string;
  leasePath: string;
  lease: FencedWriterLease;
  ttlMs?: number;
  nowMs?: () => number;
  onEvent?: (event: WriterLeaseEvent) => void;
}

function leaseLockId(resourceId: string): string {
  return `writer-lease-${resourceId}`;
}

/** Stable lock namespace derived from the actual durable lease path. */
export function writerLeaseResourceId(leasePath: string): string {
  return `path:${crypto.createHash('sha256').update(path.resolve(leasePath)).digest('hex')}`;
}

function readLease(leasePath: string): FencedWriterLease | undefined {
  if (!safeExistsSync(leasePath)) return undefined;
  let parsed: unknown;
  try {
    parsed = readJson<unknown>(leasePath);
  } catch {
    throw new Error(`[WRITER_LEASE_CORRUPT] unreadable lease: ${leasePath}`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`[WRITER_LEASE_CORRUPT] invalid lease: ${leasePath}`);
  }
  const candidate = parsed as Partial<FencedWriterLease>;
  if (
    typeof candidate.resource_id !== 'string' ||
    typeof candidate.owner_id !== 'string' ||
    !Number.isInteger(candidate.fence) ||
    candidate.fence < 0 ||
    !Number.isFinite(candidate.expires_at_ms)
  ) {
    throw new Error(`[WRITER_LEASE_CORRUPT] invalid lease fields: ${leasePath}`);
  }
  return candidate as FencedWriterLease;
}

function writeLease(leasePath: string, lease: FencedWriterLease): void {
  safeMkdir(path.dirname(leasePath), { recursive: true });
  safeWriteFile(leasePath, `${JSON.stringify(lease, null, 2)}\n`);
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
  event: WriterLeaseEvent
): void {
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
  assertLeaseIdentity(options);
  const now = options.nowMs ?? (() => Date.now());
  const nowMs = now();
  const current = readLease(options.leasePath);
  if (
    !current ||
    current.resource_id !== resourceId ||
    current.owner_id !== ownerId ||
    current.fence !== options.lease.fence ||
    current.expires_at_ms <= nowMs
  ) {
    emitEvent(options.onEvent, {
      type: 'rejected',
      resourceId,
      reason: 'renewal token is stale or expired',
    });
    throw new Error(
      `[WRITER_LEASE_FENCED] renewal rejected for ${resourceId} (owner=${ownerId}, fence=${options.lease.fence})`
    );
  }
  const renewed = { ...current, expires_at_ms: nowMs + ttlMs };
  writeLease(options.leasePath, renewed);
  assertFencedWriterLease(options.leasePath, renewed, now());
  emitEvent(options.onEvent, { type: 'renewed', lease: renewed });
  return renewed;
}

export async function renewFencedWriterLease(
  options: RenewFencedWriterLeaseOptions
): Promise<FencedWriterLease> {
  const { resourceId } = validateLeaseOptions(options);
  return withLock(leaseLockId(resourceId), () => renewFencedWriterLeaseUnderLock(options));
}

/** Synchronous counterpart to renewFencedWriterLease. */
function renewFencedWriterLeaseSyncUnderLock(
  options: RenewFencedWriterLeaseOptions
): FencedWriterLease {
  const { resourceId, ownerId, ttlMs } = validateLeaseOptions(options);
  assertLeaseIdentity(options);
  const now = options.nowMs ?? (() => Date.now());
  const nowMs = now();
  const current = readLease(options.leasePath);
  if (
    !current ||
    current.resource_id !== resourceId ||
    current.owner_id !== ownerId ||
    current.fence !== options.lease.fence ||
    current.expires_at_ms <= nowMs
  ) {
    emitEvent(options.onEvent, {
      type: 'rejected',
      resourceId,
      reason: 'renewal token is stale or expired',
    });
    throw new Error(
      `[WRITER_LEASE_FENCED] renewal rejected for ${resourceId} (owner=${ownerId}, fence=${options.lease.fence})`
    );
  }
  const renewed = { ...current, expires_at_ms: nowMs + ttlMs };
  writeLease(options.leasePath, renewed);
  assertFencedWriterLease(options.leasePath, renewed, now());
  emitEvent(options.onEvent, { type: 'renewed', lease: renewed });
  return renewed;
}

export function renewFencedWriterLeaseSync(
  options: RenewFencedWriterLeaseOptions
): FencedWriterLease {
  const { resourceId } = validateLeaseOptions(options);
  return withLockSync(leaseLockId(resourceId), () => renewFencedWriterLeaseSyncUnderLock(options));
}

/** Reject a writer token that no longer owns the current fence. */
export function assertFencedWriterLease(
  leasePath: string,
  expected: FencedWriterLease,
  nowMs: number
): void {
  const current = readLease(leasePath);
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

  return withLock(leaseLockId(resourceId), async () => {
    const current = readLease(options.leasePath);
    const nowMs = now();
    if (current && current.expires_at_ms > nowMs) {
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
    writeLease(options.leasePath, lease);
    assertFencedWriterLease(options.leasePath, lease, now());
    emitEvent(options.onEvent, { type: 'acquired', lease });
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
      assertFencedWriterLease(options.leasePath, lease, now());
      return result;
    } finally {
      if (renewalTimer) clearInterval(renewalTimer);
      // Preserve the fence so any writer holding an older token can never be
      // mistaken for the current owner after this lease is released.
      const latest = readLease(options.leasePath);
      if (
        latest &&
        latest.resource_id === lease.resource_id &&
        latest.owner_id === lease.owner_id &&
        latest.fence === lease.fence
      ) {
        writeLease(options.leasePath, { ...lease, expires_at_ms: 0 });
        emitEvent(options.onEvent, { type: 'released', lease: { ...lease, expires_at_ms: 0 } });
      }
    }
  });
}

/** Synchronous counterpart for JSONL/trace callbacks that cannot await. */
export function withFencedWriterLeaseSync<T>(options: WithFencedWriterLeaseSyncOptions<T>): T {
  const { resourceId, ownerId, ttlMs } = validateLeaseOptions(options);
  validateRenewalInterval(options.renewEveryMs, ttlMs);
  const now = options.nowMs ?? (() => Date.now());

  return withLockSync(leaseLockId(resourceId), () => {
    const current = readLease(options.leasePath);
    const nowMs = now();
    if (current && current.expires_at_ms > nowMs) {
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
    writeLease(options.leasePath, lease);
    assertFencedWriterLease(options.leasePath, lease, now());
    emitEvent(options.onEvent, { type: 'acquired', lease });
    try {
      const result = options.fn(lease);
      assertFencedWriterLease(options.leasePath, lease, now());
      return result;
    } finally {
      const latest = readLease(options.leasePath);
      if (
        latest &&
        latest.resource_id === lease.resource_id &&
        latest.owner_id === lease.owner_id &&
        latest.fence === lease.fence
      ) {
        writeLease(options.leasePath, { ...lease, expires_at_ms: 0 });
        emitEvent(options.onEvent, { type: 'released', lease: { ...lease, expires_at_ms: 0 } });
      }
    }
  });
}
