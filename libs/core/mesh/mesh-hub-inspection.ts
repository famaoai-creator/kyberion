import {
  listMeshPeerDirectoryEntries,
  listMeshPeerPresenceRecords,
  type MeshPeerDirectoryEntry,
} from './mesh-peer-directory.js';
import {
  type MeshDeliveryRecord,
  type MeshDeliveryStatus,
  type MeshFailureClass,
  type MeshPayloadReference,
  type MeshRequest,
  type MeshRequestKind,
  type MeshTargetSelector,
} from './mesh-hub-contract.js';
import { logger } from '../core.js';
import { isValidTenantSlug } from '../entity-scope.js';
import { isRecord, sanitizeIdSegment } from '../foundation/text.js';
import { normalizeIso, nowIso } from '../foundation/time.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from '../secure-io.js';
import { streamJsonLinesAcrossCompaction } from '../storage/jsonl-parked-read.js';

export interface MeshDeadLetterRecord {
  kind: 'mesh-dead-letter-record';
  dead_letter_id: string;
  delivery_id: string;
  request_id: string;
  tenant_scope: MeshRequest['tenant_scope'];
  request_kind: MeshRequestKind;
  target: {
    selector: MeshTargetSelector;
  };
  payload: MeshPayloadReference & {
    classification: MeshRequest['payload']['classification'];
  };
  attempt_count: number;
  status: MeshDeliveryStatus;
  failure_class: MeshFailureClass;
  redacted_reason: string;
  created_at: string;
}

export interface MeshHubPeerInspection {
  peer_id: string;
  tenant_id?: string;
  source: MeshPeerDirectoryEntry['source'];
  status: MeshPeerDirectoryEntry['status'];
  heartbeat_age_ms: number | null;
  heartbeat_state: 'healthy' | 'expired' | 'missing';
  capabilities: string[];
  eligible_request_kinds: string[];
}

export interface MeshHubDeliveryInspection {
  delivery_id: string;
  request_id: string;
  request_kind: MeshDeliveryRecord['request_kind'];
  target_selector: MeshTargetSelector;
  state: MeshDeliveryRecord['status'];
  retry_count: number;
  expires_at: string;
  route_explanation: string;
  selected_peer_id: string | null;
  failure_class?: MeshDeliveryRecord['failure_class'];
}

export interface MeshHubInspectionReport {
  generated_at: string;
  peer_count: number;
  route_count: number;
  delivery_count: number;
  dead_letter_count: number;
  peers: MeshHubPeerInspection[];
  routes: MeshHubDeliveryInspection[];
  dead_letters: MeshDeadLetterRecord[];
}

export interface MeshHubInspectionOptions {
  tenantId?: string;
  now?: string | Date;
  namespace?: string;
}

/**
 * Read side of the mesh delivery ledger (`deliveries.jsonl` / `dead-letter.jsonl`
 * under `active/shared/runtime/mesh-hub[/<ns>]/tenants/<t>/`). The broker and
 * delivery driver that wrote these stores were retired on 2026-11-12
 * (`retired/libs-core/mesh/mesh-message-broker.ts`); nothing appends to them
 * any more. The reader stays so a runtime root that still holds earlier rows
 * keeps reporting them: one snapshot row per state change, latest row per key.
 */
function meshLedgerPath(namespace: string | undefined, tenantId: string, file: string): string {
  const suffix = sanitizeIdSegment(namespace || '', { maxLength: 64 });
  const root = suffix
    ? `active/shared/runtime/mesh-hub/${suffix}`
    : 'active/shared/runtime/mesh-hub';
  return `${root}/tenants/${tenantId}/${file}`;
}

function latestLedgerRows<T>(logicalPath: string, key: string): T[] {
  const safePath = assertSafeRepositoryPath(logicalPath, { allowMissingLeaf: true });
  if (safeExistsSync(safePath) && !safeLstat(safePath).isFile()) {
    throw new Error(`mesh-hub persisted JSONL must be a regular file: ${safePath}`);
  }
  const index = new Map<string, T>();
  let malformed = 0;
  for (const row of streamJsonLinesAcrossCompaction<unknown>(safePath, {
    onMalformed: () => {
      malformed += 1;
    },
  })) {
    if (!isRecord(row)) continue;
    const value = row[key];
    if (typeof value === 'string' && value) index.set(value, row as unknown as T);
  }
  if (malformed > 0) {
    logger.warn(
      `[mesh-hub] skipped ${malformed} malformed line(s) in ${logicalPath} — torn append or corrupted row | next: inspect the store if this repeats | evidence: remaining rows were read`
    );
  }
  return Array.from(index.values());
}

function heartbeatAgeMs(record: { heartbeat_at: string }, now: string): number {
  return Math.max(0, new Date(now).getTime() - new Date(record.heartbeat_at).getTime());
}

function summarizeRoute(delivery: MeshDeliveryRecord): string {
  const route = delivery.route;
  const selector = route.selector;
  const selectedPeer = route.selected_peer_id ? ` selected=${route.selected_peer_id}` : '';
  const fanOut =
    route.decision === 'direct'
      ? 'direct'
      : route.decision === 'requires_operator_selection'
        ? 'operator-selection'
        : route.decision;
  const selectorSummary =
    selector.kind === 'peer'
      ? `peer:${selector.peer_id}`
      : selector.kind === 'role'
        ? `role:${selector.role}`
        : selector.kind === 'capability'
          ? `capability:${selector.capability_id}${selector.version ? `@${selector.version}` : ''}`
          : `topic:${selector.topic}`;
  return `${selectorSummary} -> ${fanOut}${selectedPeer} policy=${route.policy_version}`;
}

function buildPeerInspection(
  now: string,
  peer: MeshPeerDirectoryEntry,
  presenceRecord: { heartbeat_at: string; expires_at: string } | null
): MeshHubPeerInspection {
  const heartbeatState = !presenceRecord
    ? 'missing'
    : presenceRecord.expires_at <= now
      ? 'expired'
      : 'healthy';
  return {
    peer_id: peer.peer_id,
    tenant_id: peer.tenant_id,
    source: peer.source,
    status: peer.status,
    heartbeat_age_ms: presenceRecord ? heartbeatAgeMs(presenceRecord, now) : null,
    heartbeat_state: heartbeatState,
    capabilities: peer.capabilities.map((capability) => capability.capability_id),
    eligible_request_kinds: peer.allowed_request_kinds,
  };
}

/**
 * Read-only operator view over the mesh-hub stores: the peer directory
 * (written by `peer_conversation_server`), and the delivery / dead-letter
 * ledger, which has had no writer since the broker and delivery driver were
 * retired on 2026-11-12 (rows from before that are still reported). Topic
 * subscriptions are no longer reported: their writer and router were retired
 * on 2026-10-01 and the read side followed on 2026-10-31
 * (`retired/libs-core/mesh/mesh-topic-registry.ts`).
 */
export async function inspectMeshHub(
  options: MeshHubInspectionOptions = {}
): Promise<MeshHubInspectionReport> {
  const tenantId = String(options.tenantId || '').trim();
  if (!isValidTenantSlug(tenantId)) {
    throw new Error(`mesh_inspection_invalid_tenant_id:${tenantId}`);
  }
  const now = normalizeIso(options.now);
  const namespace = options.namespace || undefined;
  const directories = listMeshPeerDirectoryEntries(tenantId, now);
  const presences = listMeshPeerPresenceRecords(tenantId);
  const deliveryRecords = latestLedgerRows<MeshDeliveryRecord & { expires_at: string }>(
    meshLedgerPath(namespace, tenantId, 'deliveries.jsonl'),
    'delivery_id'
  );
  const deadLetters = latestLedgerRows<MeshDeadLetterRecord>(
    meshLedgerPath(namespace, tenantId, 'dead-letter.jsonl'),
    'dead_letter_id'
  ).filter((record) => record.tenant_scope.tenant_id === tenantId);
  const presenceByPeer = new Map(presences.map((record) => [record.peer_id, record] as const));
  const peerInspections = directories.map((peer) =>
    buildPeerInspection(now, peer, presenceByPeer.get(peer.peer_id) || null)
  );

  const deliveries = deliveryRecords.map<MeshHubDeliveryInspection>((delivery) => ({
    delivery_id: delivery.delivery_id,
    request_id: delivery.request_id,
    request_kind: delivery.request_kind,
    target_selector: delivery.target.selector,
    state: delivery.status,
    retry_count: delivery.attempt_count,
    expires_at: delivery.expires_at,
    route_explanation: summarizeRoute(delivery),
    selected_peer_id: delivery.route.selected_peer_id || null,
    ...(delivery.failure_class ? { failure_class: delivery.failure_class } : {}),
  }));

  return {
    generated_at: nowIso(),
    peer_count: peerInspections.length,
    route_count: deliveries.length,
    delivery_count: deliveries.length,
    dead_letter_count: deadLetters.length,
    peers: peerInspections,
    routes: deliveries,
    dead_letters: deadLetters,
  };
}

export function formatMeshHubInspectionReport(report: MeshHubInspectionReport): string[] {
  const lines: string[] = [];
  lines.push(`Mesh Hub inspection ${report.generated_at}`);
  lines.push(
    `Peers: ${report.peer_count}  Deliveries: ${report.delivery_count}  Dead letters: ${report.dead_letter_count}`
  );
  lines.push('');
  lines.push('Peers');
  for (const peer of report.peers) {
    lines.push(
      `- ${peer.peer_id} | ${peer.tenant_id || 'unknown'} | ${peer.heartbeat_state} | ${peer.status} | age=${peer.heartbeat_age_ms ?? 'n/a'}ms | caps=${peer.capabilities.join(', ') || 'none'}`
    );
  }
  lines.push('');
  lines.push('Routes');
  for (const route of report.routes) {
    lines.push(
      `- ${route.delivery_id} | ${route.state} | retry=${route.retry_count} | expires=${route.expires_at} | ${route.route_explanation}`
    );
  }
  lines.push('');
  lines.push('Dead letters');
  for (const deadLetter of report.dead_letters) {
    lines.push(
      `- ${deadLetter.dead_letter_id} | ${deadLetter.delivery_id} | ${deadLetter.failure_class} | ${deadLetter.redacted_reason}`
    );
  }
  return lines;
}
