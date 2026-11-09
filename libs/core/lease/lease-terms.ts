/**
 * lease-terms — the one place that decides who holds a lease, until when,
 * and in which generation (Concept Model v2 D2, W3).
 *
 * Every lease in Kyberion — WorkItem claims, Co-Session path leases, device
 * leases, mission leases, dot slots — is a resource kind plus a resource name.
 * Adapters keep their own record shape (so on-disk data and readers stay
 * compatible) but never compute an expiry, pick a holder or advance a fence
 * themselves: they call these functions and copy the returned terms.
 * `tests/lease-bookkeeping-boundary.test.ts` enforces that rule.
 *
 * The functions are pure (the caller supplies `nowMs` and the previous
 * generation). Exclusion is the caller's lock — a `LeaseBackend` namespace
 * (`resource-lease.ts`) or a store mutex that already serializes the record.
 */

import type { LeaseResourceKind } from './lease-backend.js';

export type LeaseTermsErrorCode =
  /** Malformed input: blank resource/holder, non-positive TTL, bad clock. */
  | 'LEASE_INVALID_ARGUMENT'
  /** A live lease of another generation is held — acquisition refused. */
  | 'LEASE_HELD'
  /** The caller is not the holder of the lease it tried to renew/release. */
  | 'LEASE_NOT_HOLDER'
  /** The lease is past its expiry; renewal never revives a lapsed lease. */
  | 'LEASE_EXPIRED'
  /** The fencing token cannot advance safely. */
  | 'LEASE_EXHAUSTED';

export class LeaseTermsError extends Error {
  readonly code: LeaseTermsErrorCode;
  /** Current holder, when the refusal is about someone else's live lease. */
  readonly holder?: string;
  readonly expires_at_ms?: number;

  constructor(
    code: LeaseTermsErrorCode,
    message: string,
    detail: { holder?: string; expires_at_ms?: number } = {}
  ) {
    super(`[${code}] ${message}`);
    this.name = 'LeaseTermsError';
    this.code = code;
    if (detail.holder !== undefined) this.holder = detail.holder;
    if (detail.expires_at_ms !== undefined) this.expires_at_ms = detail.expires_at_ms;
  }
}

/** The decided terms of one lease generation. */
export interface LeaseTerms {
  resource_kind: LeaseResourceKind;
  resource_id: string;
  holder: string;
  /** Monotonic per resource; survives release and expiry. */
  fence: number;
  acquired_at_ms: number;
  renewed_at_ms: number;
  /** Epoch ms after which the lease no longer counts as held; 0 once released. */
  expires_at_ms: number;
}

/** The previous generation as an adapter knows it (any field may be missing on legacy data). */
export interface LeaseGeneration {
  holder?: string;
  fence?: number;
  /** Epoch ms or an ISO timestamp (WorkItem / Co-Session records store ISO). */
  expires_at?: number | string;
  /** Explicitly released generations never count as live, whatever their expiry. */
  released?: boolean;
}

export const DEFAULT_LEASE_TTL_MS = 30_000;

/** Epoch ms of an expiry stored as ms or ISO; NaN when unreadable. */
export function leaseExpiryMs(value: number | string | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim()) return Date.parse(value);
  return Number.NaN;
}

/** ISO projection of an expiry for records that store timestamps as strings. */
export function leaseExpiresAtIso(terms: Pick<LeaseTerms, 'expires_at_ms'>): string {
  return new Date(terms.expires_at_ms).toISOString();
}

/**
 * A lease counts as held only while its expiry is strictly in the future.
 * Unreadable expiries are never live (fail closed for holders, open for
 * contenders — the same rule every adapter used before W3).
 */
export function isLeaseLive(
  lease: { expires_at?: number | string; expires_at_ms?: number; released?: boolean },
  nowMs: number = Date.now()
): boolean {
  if (lease.released) return false;
  const expiry = leaseExpiryMs(lease.expires_at_ms ?? lease.expires_at);
  return Number.isFinite(expiry) && expiry > nowMs;
}

/** True when `holder` is the holder of `lease` (exact, trimmed match). */
export function isLeaseHeldBy(lease: { holder?: string }, holder: string | undefined): boolean {
  const expected = typeof holder === 'string' ? holder.trim() : '';
  return Boolean(expected) && lease.holder === expected;
}

function requireText(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new LeaseTermsError('LEASE_INVALID_ARGUMENT', `${field} is required`);
  return text;
}

function requireClock(nowMs: number): number {
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new LeaseTermsError('LEASE_INVALID_ARGUMENT', 'nowMs must be finite and nonnegative');
  }
  return nowMs;
}

function futureExpiry(nowMs: number, ttlMs: number): number {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new LeaseTermsError('LEASE_INVALID_ARGUMENT', 'ttlMs must be a positive finite number');
  }
  const expiry = nowMs + ttlMs;
  if (!Number.isFinite(expiry) || expiry <= nowMs) {
    throw new LeaseTermsError(
      'LEASE_INVALID_ARGUMENT',
      'ttlMs must produce a finite strictly future expiry'
    );
  }
  return expiry;
}

function nextFence(previous: number | undefined): number {
  const fence =
    Number.isSafeInteger(previous) && (previous as number) > 0 ? (previous as number) : 0;
  if (fence >= Number.MAX_SAFE_INTEGER) {
    throw new LeaseTermsError('LEASE_EXHAUSTED', 'fencing token cannot advance safely');
  }
  return fence + 1;
}

/**
 * Grant a new generation. Refuses with `LEASE_HELD` while `previous` is live —
 * including when the same holder asks again: re-entry is the adapter's call
 * (replay, idempotent re-acquire, or `renewLeaseTerms`), never implicit.
 */
export function grantLeaseTerms(input: {
  kind: LeaseResourceKind;
  resourceId: string;
  holder: string;
  ttlMs: number;
  nowMs: number;
  previous?: LeaseGeneration;
}): LeaseTerms {
  const resource_id = requireText(input.resourceId, 'resourceId');
  const holder = requireText(input.holder, 'holder');
  const nowMs = requireClock(input.nowMs);
  const expires_at_ms = futureExpiry(nowMs, input.ttlMs);
  const previous = input.previous;
  if (previous && isLeaseLive(previous, nowMs)) {
    const until = leaseExpiryMs(previous.expires_at);
    throw new LeaseTermsError(
      'LEASE_HELD',
      `${input.kind}:${resource_id} is held by '${previous.holder ?? 'unknown'}' until ${new Date(until).toISOString()}`,
      { ...(previous.holder ? { holder: previous.holder } : {}), expires_at_ms: until }
    );
  }
  return {
    resource_kind: input.kind,
    resource_id,
    holder,
    fence: nextFence(previous?.fence),
    acquired_at_ms: nowMs,
    renewed_at_ms: nowMs,
    expires_at_ms,
  };
}

/**
 * Extend a live lease for its holder without changing the fence. Collects the
 * refusal reason: `LEASE_NOT_HOLDER` before `LEASE_EXPIRED`.
 */
export function renewLeaseTerms(
  current: LeaseTerms,
  input: { holder?: string; ttlMs: number; nowMs: number }
): LeaseTerms {
  const nowMs = requireClock(input.nowMs);
  const expires_at_ms = futureExpiry(nowMs, input.ttlMs);
  if (input.holder !== undefined && !isLeaseHeldBy(current, input.holder)) {
    throw new LeaseTermsError(
      'LEASE_NOT_HOLDER',
      `${current.resource_kind}:${current.resource_id} is held by '${current.holder}', not '${input.holder}'`,
      { holder: current.holder, expires_at_ms: current.expires_at_ms }
    );
  }
  if (!isLeaseLive(current, nowMs)) {
    throw new LeaseTermsError(
      'LEASE_EXPIRED',
      `${current.resource_kind}:${current.resource_id} lease lapsed at ${current.expires_at_ms}ms (now=${nowMs}ms)`,
      { holder: current.holder, expires_at_ms: current.expires_at_ms }
    );
  }
  return { ...current, renewed_at_ms: nowMs, expires_at_ms };
}

/** Released terms: the fence is kept so an older token can never look current. */
export function releaseLeaseTerms(current: LeaseTerms): LeaseTerms {
  return { ...current, expires_at_ms: 0 };
}

/**
 * Rebuild terms from an adapter record (the inverse of copying them in).
 * Missing timestamps fall back to the expiry, missing fences to 0 (legacy).
 */
export function leaseTermsFromRecord(input: {
  kind: LeaseResourceKind;
  resourceId: string;
  holder: string;
  fence?: number;
  expires_at: number | string;
  acquired_at?: number | string;
  renewed_at?: number | string;
}): LeaseTerms {
  const expires_at_ms = leaseExpiryMs(input.expires_at);
  const acquired = leaseExpiryMs(input.acquired_at);
  const renewed = leaseExpiryMs(input.renewed_at);
  return {
    resource_kind: input.kind,
    resource_id: input.resourceId,
    holder: input.holder,
    fence: Number.isSafeInteger(input.fence) ? (input.fence as number) : 0,
    acquired_at_ms: Number.isFinite(acquired) ? acquired : expires_at_ms,
    renewed_at_ms: Number.isFinite(renewed) ? renewed : expires_at_ms,
    expires_at_ms,
  };
}
