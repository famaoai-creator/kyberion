import {
  acknowledgeMeshDelivery,
  claimDueMeshDeliveries,
  expireMeshDeliveries,
  retryMeshDelivery,
} from './mesh-message-broker.js';
import {
  createMeshHubPeerMessagingAdapter,
  type MeshHubDispatchInput,
} from './mesh-hub-peer-messaging-adapter.js';
import { resolvePeerRecord, type PeerNetworkPeerRecord } from './peer-messaging.js';
import type { MeshDeliveryRecord, MeshRequest } from './mesh-hub-contract.js';
import type { MeshRetryPolicy } from './mesh-message-broker.js';
import { logger } from './core.js';
import { acquireLock, releaseLock } from './src/lock-utils.js';

/**
 * AA-02: delivery driver for the Mesh Hub at-least-once state machine.
 *
 * The broker (mesh-message-broker.ts) owns the ledger, dedup, backoff and
 * dead-lettering; this driver is the previously-missing propulsion: it claims
 * due deliveries, dispatches them to the selected peer over HTTP+HMAC, acks
 * successes and feeds failures back into the broker's retry state machine.
 *
 * Single-pass by design so it can run under the chronos cron (KM-01) without
 * adding a resident process; `--loop` in the CLI wraps this for daemon use.
 */

export interface MeshDeliveryDispatcher {
  dispatchToPeer(input: MeshHubDispatchInput): Promise<unknown>;
}

/** Ledger operations the pass needs; defaults to the shared-namespace broker. */
export interface MeshDeliveryBrokerOps {
  expireMeshDeliveries(now: string): Promise<MeshDeliveryRecord[]>;
  claimDueMeshDeliveries(now: string, limit?: number): Promise<MeshDeliveryRecord[]>;
  acknowledgeMeshDelivery(deliveryId: string, receipt: Record<string, unknown>): Promise<unknown>;
  retryMeshDelivery(
    deliveryId: string,
    now: string,
    retryPolicy?: Partial<MeshRetryPolicy>
  ): Promise<{ status: string }>;
}

export interface MeshDeliveryPassOptions {
  /** This host's peer id (sender_peer_id on reconstructed requests). */
  senderPeerId: string;
  /** Fallback shared secret when the peer record does not carry one. */
  sharedSecret?: string;
  batchLimit?: number;
  now?: string;
  dispatcher?: MeshDeliveryDispatcher;
  resolvePeer?: (peerId: string) => PeerNetworkPeerRecord | null;
  retryPolicy?: Partial<MeshRetryPolicy>;
  dispatchTimeoutMs?: number;
  /**
   * AA-02 writer fencing: lock id guarding the whole pass. Override in tests
   * for isolation; set only when a deployment intentionally shards drivers.
   */
  writerLockId?: string;
  /** How long to wait for the writer lock before skipping the pass. */
  writerLockTimeoutMs?: number;
  /** Ledger backend override — a namespaced broker instance (tests / shards). */
  broker?: MeshDeliveryBrokerOps;
}

export interface MeshDeliveryPassReport {
  expired: number;
  claimed: number;
  delivered: number;
  retried: number;
  dead_lettered: number;
  unroutable: number;
  failures: Array<{ delivery_id: string; reason: string }>;
  /** True when another driver held the writer lock and this pass did nothing. */
  skipped?: boolean;
}

const DEFAULT_BATCH_LIMIT = 10;
const DEFAULT_REQUEST_TTL_MS = 60_000;
const DEFAULT_WRITER_LOCK_ID = 'mesh-delivery-writer';
const DEFAULT_WRITER_LOCK_TIMEOUT_MS = 500;

/**
 * The broker persists idempotency_key / expires_at on every delivery row but
 * types the public record without them; recover them here so the receiver's
 * dedup keeps working across redeliveries.
 */
function reconstructMeshRequest(delivery: MeshDeliveryRecord, senderPeerId: string): MeshRequest {
  const stored = delivery as MeshDeliveryRecord & {
    idempotency_key?: string;
    expires_at?: string;
  };
  const ttlMs = stored.expires_at
    ? Math.max(1, Date.parse(stored.expires_at) - Date.parse(delivery.created_at))
    : DEFAULT_REQUEST_TTL_MS;
  return {
    kind: 'mesh-request',
    request_id: delivery.request_id,
    tenant_scope: delivery.tenant_scope,
    sender_peer_id: senderPeerId,
    created_at: delivery.created_at,
    ttl_ms: ttlMs,
    idempotency_key: stored.idempotency_key || delivery.delivery_id,
    correlation_id: delivery.request_id,
    request_kind: delivery.request_kind,
    target: delivery.target,
    payload: delivery.payload,
  };
}

export async function runMeshDeliveryPass(
  options: MeshDeliveryPassOptions
): Promise<MeshDeliveryPassReport> {
  // AA-02 writer fencing: exactly one driver mutates the delivery ledger at
  // a time. Overlapping passes (cron tick + manual run, or a slow previous
  // pass) skip instead of queuing — the next tick picks the work up, and
  // skipping can never double-dispatch a claimed delivery. Crash tolerance
  // comes from lock-utils' PID staleness takeover; release is PID-checked so
  // a fenced-out driver cannot delete a lock someone else took over.
  const lockId = options.writerLockId ?? DEFAULT_WRITER_LOCK_ID;
  const acquired = await acquireLock(
    lockId,
    options.writerLockTimeoutMs ?? DEFAULT_WRITER_LOCK_TIMEOUT_MS
  );
  if (!acquired) {
    logger.warn(`[mesh-delivery-driver] writer lock '${lockId}' held elsewhere — skipping pass`);
    return {
      expired: 0,
      claimed: 0,
      delivered: 0,
      retried: 0,
      dead_lettered: 0,
      unroutable: 0,
      failures: [],
      skipped: true,
    };
  }
  try {
    return await runMeshDeliveryPassUnfenced(options);
  } finally {
    releaseLock(lockId);
  }
}

async function runMeshDeliveryPassUnfenced(
  options: MeshDeliveryPassOptions
): Promise<MeshDeliveryPassReport> {
  const now = options.now || new Date().toISOString();
  const broker: MeshDeliveryBrokerOps = options.broker ?? {
    expireMeshDeliveries,
    claimDueMeshDeliveries,
    acknowledgeMeshDelivery,
    retryMeshDelivery,
  };
  const dispatcher =
    options.dispatcher ||
    createMeshHubPeerMessagingAdapter({
      peerId: options.senderPeerId,
      sharedSecret: options.sharedSecret || '',
    });
  const resolvePeer = options.resolvePeer || ((peerId: string) => resolvePeerRecord(peerId));

  const report: MeshDeliveryPassReport = {
    expired: 0,
    claimed: 0,
    delivered: 0,
    retried: 0,
    dead_lettered: 0,
    unroutable: 0,
    failures: [],
  };

  report.expired = (await broker.expireMeshDeliveries(now)).length;

  const claimed = await broker.claimDueMeshDeliveries(
    now,
    options.batchLimit ?? DEFAULT_BATCH_LIMIT
  );
  report.claimed = claimed.length;

  for (const delivery of claimed) {
    const peerId = delivery.route.selected_peer_id;
    const routable = delivery.route.decision === 'direct' && peerId;
    const peer = routable ? resolvePeer(peerId as string) : null;

    if (!peer || !peer.base_url) {
      // Unroutable deliveries go back through the broker's retry state machine
      // (and eventually dead-letter) instead of being dropped silently. Peer
      // selection stays a governance decision — never auto-selected here.
      report.unroutable += 1;
      await recordFailure(delivery, `peer_unroutable:${peerId || 'unselected'}`, report);
      continue;
    }

    try {
      await dispatcher.dispatchToPeer({
        recipient: peer,
        request: reconstructMeshRequest(delivery, options.senderPeerId),
        timeoutMs: options.dispatchTimeoutMs,
      });
      await broker.acknowledgeMeshDelivery(delivery.delivery_id, {});
      report.delivered += 1;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await recordFailure(delivery, reason, report);
    }
  }

  async function recordFailure(
    delivery: MeshDeliveryRecord,
    reason: string,
    target: MeshDeliveryPassReport
  ): Promise<void> {
    target.failures.push({ delivery_id: delivery.delivery_id, reason });
    try {
      const next = await broker.retryMeshDelivery(delivery.delivery_id, now, options.retryPolicy);
      if (next.status === 'dead_lettered' || next.status === 'expired') {
        target.dead_lettered += 1;
      } else {
        target.retried += 1;
      }
    } catch (retryErr) {
      const detail = retryErr instanceof Error ? retryErr.message : String(retryErr);
      logger.warn(
        `[mesh-delivery-driver] retry bookkeeping failed for ${delivery.delivery_id}: ${detail}`
      );
    }
  }

  return report;
}

export function formatMeshDeliveryPassReport(report: MeshDeliveryPassReport): string {
  if (report.skipped) {
    return '[mesh-delivery] skipped (writer lock held by another driver)';
  }
  const parts = [
    `claimed=${report.claimed}`,
    `delivered=${report.delivered}`,
    `retried=${report.retried}`,
    `dead_lettered=${report.dead_lettered}`,
    `unroutable=${report.unroutable}`,
    `expired=${report.expired}`,
  ];
  return `[mesh-delivery] ${parts.join(' ')}`;
}
