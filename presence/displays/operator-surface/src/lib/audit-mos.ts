/**
 * MOS read-only audit emitter.
 *
 * Per operator-surface-strategy.md §9.1, the MOS must emit `mos.read`
 * audit events for every operator page view, scoped to the active
 * tenant. Those entries land on the same hash-chained audit-chain so
 * a tenant's CISO can verify "every read against my data has a record".
 *
 * This is the **only** place in the MOS that touches a write surface —
 * and it is a write to the audit chain, not to mission state. The
 * `test/no-write-api.test.ts` contract test deliberately allows
 * `auditChain` references via this module only; any other call site
 * importing `auditChain.record` directly will trip the test.
 */

import { auditChain } from '@agent/core';
import { getTenantScope } from './data.js';

export interface MosReadEvent {
  page: string;
  resource_kind: 'mission_list' | 'mission_detail' | 'audit' | 'health' | 'knowledge' | 'intent_snapshots';
  resource_id?: string;
  result_count?: number;
}

export function emitMosRead(event: MosReadEvent): void {
  try {
    auditChain.record({
      agentId: 'mos',
      action: 'mos.read',
      operation: event.page,
      result: 'completed',
      metadata: {
        resource_kind: event.resource_kind,
        ...(event.resource_id ? { resource_id: event.resource_id } : {}),
        ...(event.result_count !== undefined ? { result_count: event.result_count } : {}),
        ...(getTenantScope() ? { tenant_scope: getTenantScope() } : {}),
      },
    });
  } catch (err) {
    // Audit failures must not block rendering. The hash-chain is
    // authoritative on disk; the in-process emit is best-effort.
    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.warn('[mos] failed to emit mos.read audit event', err);
    }
  }
}
