/**
 * work-item-lease — the `work_item` adapter over the lease primitive (W3).
 *
 * A WorkItem claim is a lease on resource `work_item:<item_id>`. Holder,
 * expiry, liveness and the fence are decided by `libs/core/lease/`
 * (`lease-terms.ts`); this module only maps those terms onto the persisted
 * `WorkLease` snapshot shape, which stays unchanged on disk (leases.jsonl)
 * apart from the optional `fence`. Records written before W3 carry no fence
 * and read as generation 0, so the first post-W3 claim of an item takes 1.
 *
 * Exclusion for this kind is the coordination store mutex
 * (`withCoordinationMutation`), which already serializes every lease
 * snapshot write; the record itself stays in the coordination ledger so the
 * claim history, idempotency and attempt links keep one home.
 */

import { recordLeaseAuditEvent, type LeaseAuditEvent } from '../lease/lease-audit.js';
import {
  grantLeaseTerms,
  isLeaseHeldBy,
  isLeaseLive,
  leaseExpiresAtIso,
  LeaseTermsError,
  leaseTermsFromRecord,
  renewLeaseTerms,
  type LeaseTerms,
} from '../lease/lease-terms.js';
import { WorkCoordinationError } from './work-coordination-error.js';
import type { WorkLease } from './work-coordination-types.js';

export const DEFAULT_WORK_ITEM_LEASE_TTL_MS = 15 * 60 * 1000;

/** The lease-owned fields of a WorkLease snapshot. */
export type WorkLeaseTermFields = Pick<WorkLease, 'holder_peer_id' | 'expires_at' | 'fence'>;

/** Terms view of a stored WorkLease. */
export function workLeaseTerms(lease: WorkLease): LeaseTerms {
  return leaseTermsFromRecord({
    kind: 'work_item',
    resourceId: lease.item_id,
    holder: lease.holder_peer_id,
    ...(lease.fence !== undefined ? { fence: lease.fence } : {}),
    expires_at: lease.expires_at,
    acquired_at: lease.created_at,
    renewed_at: lease.renewed_at,
  });
}

/** A WorkLease holds the item only while stored active and before its expiry. */
export function isWorkLeaseLive(lease: WorkLease, nowMs: number = Date.now()): boolean {
  return lease.status === 'active' && isLeaseLive(lease, nowMs);
}

/** True when `holder` is the lease's holder. */
export function isWorkLeaseHeldBy(lease: WorkLease, holder: string | undefined): boolean {
  return isLeaseHeldBy(workLeaseTerms(lease), holder);
}

function termFields(terms: LeaseTerms): WorkLeaseTermFields {
  return {
    holder_peer_id: terms.holder,
    expires_at: leaseExpiresAtIso(terms),
    fence: terms.fence,
  };
}

/**
 * Grant the next claim generation for `itemId`. `history` is every lease
 * snapshot of the item (any status); the fence advances past the highest one.
 * Refusals surface as coordination errors: `lease_conflict` while one of them
 * is still live, `validation_error` for malformed input.
 */
export function grantWorkItemLeaseTerms(input: {
  itemId: string;
  holder: string;
  ttlMs?: number;
  nowMs?: number;
  history: readonly WorkLease[];
}): WorkLeaseTermFields {
  const nowMs = input.nowMs ?? Date.now();
  const live = input.history.find((lease) => isWorkLeaseLive(lease, nowMs));
  const highest = input.history.reduce(
    (fence, lease) => Math.max(fence, Number.isSafeInteger(lease.fence) ? lease.fence! : 0),
    0
  );
  try {
    return termFields(
      grantLeaseTerms({
        kind: 'work_item',
        resourceId: input.itemId,
        holder: input.holder,
        ttlMs: input.ttlMs || DEFAULT_WORK_ITEM_LEASE_TTL_MS,
        nowMs,
        previous: live
          ? { holder: live.holder_peer_id, fence: highest, expires_at: live.expires_at }
          : { fence: highest, released: true },
      })
    );
  } catch (error) {
    if (!(error instanceof LeaseTermsError)) throw error;
    throw new WorkCoordinationError(
      error.code === 'LEASE_HELD' ? 'lease_conflict' : 'validation_error',
      error.message,
      { item_id: input.itemId, ...(live ? { lease_id: live.lease_id } : {}) }
    );
  }
}

/**
 * Renew a live claim (fence unchanged). `holder` is checked when given.
 * Refusals keep the coordination store's messages: holder mismatch, lapsed.
 */
export function renewWorkItemLeaseTerms(
  lease: WorkLease,
  input: { leaseId: string; holder?: string; ttlMs?: number; nowMs?: number }
): WorkLeaseTermFields {
  try {
    return termFields(
      renewLeaseTerms(workLeaseTerms(lease), {
        ...(input.holder ? { holder: input.holder } : {}),
        ttlMs: input.ttlMs || DEFAULT_WORK_ITEM_LEASE_TTL_MS,
        nowMs: input.nowMs ?? Date.now(),
      })
    );
  } catch (error) {
    if (!(error instanceof LeaseTermsError)) throw error;
    if (error.code === 'LEASE_INVALID_ARGUMENT')
      throw new WorkCoordinationError('validation_error', error.message, {
        lease_id: input.leaseId,
      });
    if (error.code === 'LEASE_NOT_HOLDER')
      throw new WorkCoordinationError(
        'lease_conflict',
        `lease holder mismatch for renewal: ${input.leaseId}`,
        {
          lease_id: input.leaseId,
          holder_peer_id: lease.holder_peer_id,
          actor_peer_id: input.holder,
        }
      );
    throw new WorkCoordinationError('lease_conflict', `lease already lapsed: ${input.leaseId}`, {
      lease_id: input.leaseId,
      expires_at: lease.expires_at,
    });
  }
}

/**
 * The one audit shape for WorkItem claim events. `item` supplies the tenant
 * scope; `actorId` names who caused the event when it is not the holder.
 */
export function auditWorkItemLease(
  event: LeaseAuditEvent,
  lease: WorkLease,
  item?: { context?: { tenant_slug?: string } } | null,
  actorId?: string
): void {
  const terms = workLeaseTerms(lease);
  const tenantSlug = item?.context?.tenant_slug;
  recordLeaseAuditEvent({
    event,
    resource_kind: 'work_item',
    resource_id: terms.resource_id,
    holder: terms.holder,
    fence: terms.fence,
    ...(event === 'release' ? {} : { expires_at_ms: terms.expires_at_ms }),
    lease_id: lease.lease_id,
    ...(actorId && actorId !== terms.holder ? { actor_id: actorId } : {}),
    ...(tenantSlug ? { tenant_slug: tenantSlug } : {}),
  });
}
