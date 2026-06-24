import {
  listMeshPeerDirectoryEntries,
  listMeshPeerPresenceRecords,
  type MeshPeerDirectoryEntry,
} from './mesh-peer-directory.js';
import {
  listMeshDeadLetters,
  listMeshDeliveries,
  type MeshDeadLetterRecord,
} from './mesh-message-broker.js';
import {
  listMeshTopicSubscriptions,
} from './mesh-topic-registry.js';
import {
  type MeshDeliveryRecord,
  type MeshTopicSubscription,
  type MeshTargetSelector,
} from './mesh-hub-contract.js';

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

export interface MeshHubTopicInspection {
  topic: string;
  tenant_id: string;
  subscribers: number;
  fan_out_count: number;
  request_kinds: string[];
  payload_classifications: string[];
  policy_version: string;
}

export interface MeshHubInspectionReport {
  generated_at: string;
  peer_count: number;
  route_count: number;
  delivery_count: number;
  dead_letter_count: number;
  topic_count: number;
  peers: MeshHubPeerInspection[];
  routes: MeshHubDeliveryInspection[];
  dead_letters: MeshDeadLetterRecord[];
  topics: MeshHubTopicInspection[];
}

export interface MeshHubInspectionOptions {
  now?: string | Date;
  namespace?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeIso(value?: string | Date): string {
  const input = value ?? new Date();
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid_iso_timestamp:${String(value)}`);
  }
  return date.toISOString();
}

function heartbeatAgeMs(record: { heartbeat_at: string }, now: string): number {
  return Math.max(0, new Date(now).getTime() - new Date(record.heartbeat_at).getTime());
}

function summarizeRoute(delivery: MeshDeliveryRecord): string {
  const route = delivery.route;
  const selector = route.selector;
  const selectedPeer = route.selected_peer_id ? ` selected=${route.selected_peer_id}` : '';
  const fanOut = route.decision === 'direct' ? 'direct' : route.decision === 'requires_operator_selection' ? 'operator-selection' : route.decision;
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
  presenceRecord: { heartbeat_at: string; expires_at: string } | null,
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

export async function inspectMeshHub(options: MeshHubInspectionOptions = {}): Promise<MeshHubInspectionReport> {
  const now = normalizeIso(options.now);
  const namespace = options.namespace || undefined;
  const directories = listMeshPeerDirectoryEntries(now);
  const presences = listMeshPeerPresenceRecords();
  const deliveryRecords = await listMeshDeliveries(namespace);
  const deadLetters = await listMeshDeadLetters({}, { namespace });
  const subscriptions = listMeshTopicSubscriptions({}, { namespace, now });
  const presenceByPeer = new Map(
    presences.map((record) => [record.peer_id, record] as const),
  );
  const peerInspections = directories.map((peer) =>
    buildPeerInspection(now, peer, presenceByPeer.get(peer.peer_id) || null),
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

  const topicIndex = new Map<string, MeshHubTopicInspection>();
  for (const subscription of subscriptions) {
    const key = `${subscription.tenant_id}::${subscription.topic}`;
    const current = topicIndex.get(key) || {
      topic: subscription.topic,
      tenant_id: subscription.tenant_id,
      subscribers: 0,
      fan_out_count: 0,
      request_kinds: [],
      payload_classifications: [],
      policy_version: subscription.policy_version,
    };
    current.subscribers += 1;
    current.fan_out_count = current.subscribers;
    current.request_kinds = Array.from(new Set([...current.request_kinds, ...subscription.filters.request_kinds]));
    current.payload_classifications = Array.from(new Set([...current.payload_classifications, ...subscription.filters.payload_classifications]));
    current.policy_version = subscription.policy_version;
    topicIndex.set(key, current);
  }

  const topics = Array.from(topicIndex.values()).sort((left, right) =>
    left.tenant_id.localeCompare(right.tenant_id) || left.topic.localeCompare(right.topic),
  );

  return {
    generated_at: nowIso(),
    peer_count: peerInspections.length,
    route_count: deliveries.length,
    delivery_count: deliveries.length,
    dead_letter_count: deadLetters.length,
    topic_count: topics.length,
    peers: peerInspections,
    routes: deliveries,
    dead_letters: deadLetters,
    topics,
  };
}

export function formatMeshHubInspectionReport(report: MeshHubInspectionReport): string[] {
  const lines: string[] = [];
  lines.push(`Mesh Hub inspection ${report.generated_at}`);
  lines.push(`Peers: ${report.peer_count}  Deliveries: ${report.delivery_count}  Dead letters: ${report.dead_letter_count}  Topics: ${report.topic_count}`);
  lines.push('');
  lines.push('Peers');
  for (const peer of report.peers) {
    lines.push(`- ${peer.peer_id} | ${peer.tenant_id || 'unknown'} | ${peer.heartbeat_state} | ${peer.status} | age=${peer.heartbeat_age_ms ?? 'n/a'}ms | caps=${peer.capabilities.join(', ') || 'none'}`);
  }
  lines.push('');
  lines.push('Routes');
  for (const route of report.routes) {
    lines.push(`- ${route.delivery_id} | ${route.state} | retry=${route.retry_count} | expires=${route.expires_at} | ${route.route_explanation}`);
  }
  lines.push('');
  lines.push('Dead letters');
  for (const deadLetter of report.dead_letters) {
    lines.push(`- ${deadLetter.dead_letter_id} | ${deadLetter.delivery_id} | ${deadLetter.failure_class} | ${deadLetter.redacted_reason}`);
  }
  lines.push('');
  lines.push('Topics');
  for (const topic of report.topics) {
    lines.push(`- ${topic.tenant_id}:${topic.topic} | subscribers=${topic.subscribers} | fan_out=${topic.fan_out_count} | request_kinds=${topic.request_kinds.join(', ')}`);
  }
  return lines;
}
