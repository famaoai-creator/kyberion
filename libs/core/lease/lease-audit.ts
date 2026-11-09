/**
 * lease-audit — one audit shape for every lease event (W3).
 *
 * Acquire, renew, release and expire of any lease kind land on the governed
 * audit chain as `action: lease.<event>`, `operation: <kind>:<resource_id>`
 * with the same metadata keys, so "who held what, when" is one query rather
 * than one per adapter. Adapters keep their own domain event logs
 * (coordination events, co-session events); this is the cross-cutting record.
 *
 * Auditing is best effort: a failed audit append is logged and never changes
 * the lease outcome (lease safety is the record and the lock, not the log).
 */

import { auditChain } from '../governance/audit-chain.js';
import { createLogger } from '../logger.js';
import type { LeaseResourceKind } from './lease-backend.js';

const log = createLogger('lease-audit');

export type LeaseAuditEvent = 'acquire' | 'renew' | 'release' | 'expire';

export const LEASE_AUDIT_ACTIONS: Record<LeaseAuditEvent, string> = {
  acquire: 'lease.acquire',
  renew: 'lease.renew',
  release: 'lease.release',
  expire: 'lease.expire',
};

export interface LeaseAuditInput {
  event: LeaseAuditEvent;
  resource_kind: LeaseResourceKind;
  resource_id: string;
  holder: string;
  fence?: number;
  /** Epoch ms; omitted for release (always 0 then). */
  expires_at_ms?: number;
  /** Adapter-local lease id, when the adapter has one. */
  lease_id?: string;
  /** Who caused the event when it is not the holder (a reaper, a forced release). */
  actor_id?: string;
  tenant_slug?: string;
  reason?: string;
}

/** Shape written to `metadata` — stable keys for every lease kind. */
export interface LeaseAuditMetadata {
  resource_kind: LeaseResourceKind;
  resource_id: string;
  holder: string;
  fence?: number;
  expires_at?: string;
  lease_id?: string;
}

export function leaseAuditMetadata(input: LeaseAuditInput): LeaseAuditMetadata {
  const expires =
    input.expires_at_ms !== undefined &&
    Number.isFinite(input.expires_at_ms) &&
    input.expires_at_ms > 0
      ? new Date(input.expires_at_ms).toISOString()
      : undefined;
  return {
    resource_kind: input.resource_kind,
    resource_id: input.resource_id,
    holder: input.holder,
    ...(Number.isSafeInteger(input.fence) ? { fence: input.fence } : {}),
    ...(expires ? { expires_at: expires } : {}),
    ...(input.lease_id ? { lease_id: input.lease_id } : {}),
  };
}

export function recordLeaseAuditEvent(input: LeaseAuditInput): void {
  try {
    auditChain.record({
      agentId: input.actor_id || input.holder || 'lease',
      action: LEASE_AUDIT_ACTIONS[input.event],
      operation: `${input.resource_kind}:${input.resource_id}`,
      result: 'completed',
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.tenant_slug ? { tenantSlug: input.tenant_slug } : {}),
      metadata: leaseAuditMetadata(input),
    });
  } catch (error) {
    log.warn(
      `lease ${input.event} audit not recorded for ${input.resource_kind}:${input.resource_id} — ${
        error instanceof Error ? error.message : String(error)
      } | next: check the audit chain (pnpm kyberion doctor) | evidence: lease outcome unchanged`
    );
  }
}
