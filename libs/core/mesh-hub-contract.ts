export const MESH_SELECTOR_KINDS = ['peer', 'role', 'capability', 'topic'] as const;
export type MeshSelectorKind = (typeof MESH_SELECTOR_KINDS)[number];

export const MESH_REQUEST_KINDS = [
  'review.request',
  'workitem.claim',
  'workitem.handoff',
  'workitem.status_update',
  'capability.query',
  'notification.publish',
] as const;
export type MeshRequestKind = (typeof MESH_REQUEST_KINDS)[number];

export const MESH_PAYLOAD_CLASSIFICATIONS = ['public', 'confidential'] as const;
export type MeshPayloadClassification = (typeof MESH_PAYLOAD_CLASSIFICATIONS)[number];

export const MESH_TOPIC_VISIBILITIES = ['peer', 'tenant'] as const;
export type MeshTopicVisibility = (typeof MESH_TOPIC_VISIBILITIES)[number];

export const MESH_DELIVERY_STATUSES = [
  'accepted',
  'queued',
  'dispatched',
  'acknowledged',
  'completed',
  'rejected',
  'expired',
  'dead_lettered',
] as const;
export type MeshDeliveryStatus = (typeof MESH_DELIVERY_STATUSES)[number];

export const MESH_FAILURE_CLASSES = [
  'transport_error',
  'policy_denied',
  'expired',
  'recipient_rejected',
  'dead_lettered',
] as const;
export type MeshFailureClass = (typeof MESH_FAILURE_CLASSES)[number];

export const MESH_RECEIVE_MODES = ['request', 'topic', 'capability_query', 'workitem'] as const;
export type MeshReceiveMode = (typeof MESH_RECEIVE_MODES)[number];

export function isMeshSelectorKind(value: string): value is MeshSelectorKind {
  return (MESH_SELECTOR_KINDS as readonly string[]).includes(value);
}

export function isMeshRequestKind(value: string): value is MeshRequestKind {
  return (MESH_REQUEST_KINDS as readonly string[]).includes(value);
}

export function isMeshPayloadClassification(value: string): value is MeshPayloadClassification {
  return (MESH_PAYLOAD_CLASSIFICATIONS as readonly string[]).includes(value);
}

export function isMeshTopicVisibility(value: string): value is MeshTopicVisibility {
  return (MESH_TOPIC_VISIBILITIES as readonly string[]).includes(value);
}

export interface MeshTenantScope {
  tenant_id: string;
  scope: 'same_tenant';
}

export interface MeshPeerRegistration {
  kind: 'mesh-peer-registration';
  peer_id: string;
  tenant_id: string;
  endpoint_ref: string;
  key_ref: string;
  status: 'enrolled' | 'revoked' | 'suspended';
  registered_at: string;
  revoked_at?: string;
  allowed_request_kinds?: MeshRequestKind[];
}

export interface MeshPeerPresenceCapacity {
  accepting_new_work: boolean;
  available_slots: number;
  max_inflight: number;
}

export interface MeshPeerPresence {
  kind: 'mesh-peer-presence';
  peer_id: string;
  tenant_id: string;
  heartbeat_at: string;
  expires_at: string;
  health: 'healthy' | 'degraded' | 'unhealthy' | 'maintenance';
  capacity: MeshPeerPresenceCapacity;
  receive_modes: MeshReceiveMode[];
}

export interface MeshCapabilityApprovalPolicy {
  requires_explicit_acceptance: boolean;
  requires_local_validation: boolean;
  requires_policy_check: boolean;
}

export interface MeshCapabilityAdvertisement {
  kind: 'mesh-capability-advertisement';
  capability_id: string;
  version: string;
  peer_id: string;
  tenant_id: string;
  roles: string[];
  request_kinds: MeshRequestKind[];
  approval_policy: MeshCapabilityApprovalPolicy;
  visibility: MeshTopicVisibility;
  advertised_at: string;
}

export interface MeshPayloadReference {
  artifact_ref: string;
  integrity_hash: string;
  storage_class: 'artifact_store' | 'vault' | 'external_ref';
}

export interface MeshRequestPayload {
  classification: MeshPayloadClassification;
  reference: MeshPayloadReference;
}

export interface MeshPeerSelector {
  kind: 'peer';
  peer_id: string;
}

export interface MeshRoleSelector {
  kind: 'role';
  role: string;
}

export interface MeshCapabilitySelector {
  kind: 'capability';
  capability_id: string;
  version?: string;
}

export interface MeshTopicSelector {
  kind: 'topic';
  topic: string;
}

export type MeshTargetSelector =
  | MeshPeerSelector
  | MeshRoleSelector
  | MeshCapabilitySelector
  | MeshTopicSelector;

export interface MeshRequest {
  kind: 'mesh-request';
  request_id: string;
  tenant_scope: MeshTenantScope;
  sender_peer_id: string;
  created_at: string;
  ttl_ms: number;
  idempotency_key: string;
  correlation_id: string;
  request_kind: MeshRequestKind;
  target: {
    selector: MeshTargetSelector;
  };
  payload: MeshRequestPayload;
}

export interface MeshDeliveryRoute {
  selector: MeshTargetSelector;
  decision: 'direct' | 'requires_operator_selection' | 'rejected';
  selected_peer_id?: string;
  selected_at?: string;
  policy_version: string;
}

export interface MeshDeliveryRecord {
  kind: 'mesh-delivery-record';
  delivery_id: string;
  message_id: string;
  request_id: string;
  tenant_scope: MeshTenantScope;
  request_kind: MeshRequestKind;
  target: {
    selector: MeshTargetSelector;
  };
  payload: MeshRequestPayload;
  attempt_count: number;
  status: MeshDeliveryStatus;
  route: MeshDeliveryRoute;
  created_at: string;
  retry_at?: string;
  failure_class?: MeshFailureClass;
}

export interface MeshTopicSubscriptionFilters {
  request_kinds: MeshRequestKind[];
  payload_classifications: MeshPayloadClassification[];
}

export interface MeshTopicSubscription {
  kind: 'mesh-topic-subscription';
  subscription_id: string;
  tenant_id: string;
  topic: string;
  peer_id: string;
  filters: MeshTopicSubscriptionFilters;
  expires_at: string;
  policy_version: string;
}

export interface MeshHubPolicy {
  version: string;
  placement: {
    mode: 'in_process_local_control_plane';
    writer_model: 'single_writer_per_runtime_root';
  };
  tenant_scope: {
    same_tenant_only: true;
    runtime_presence_required: true;
    catalog_is_bootstrap_only: true;
    catalog_cannot_override_runtime_revocation: true;
  };
  routing: {
    selectors: MeshSelectorKind[];
    request_kinds: MeshRequestKind[];
    automatic_peer_selection: 'deny';
    load_signals: string[];
  };
  data_tier: {
    personal: 'deny';
    confidential: {
      delivery_scope: 'same_tenant_only';
      hub_copy: 'deny';
      topic_reference: 'allow_only_same_tenant';
    };
    public: {
      hub_copy: 'allow_metadata_only';
    };
  };
  topic_delivery: {
    publisher_authorization: 'explicit';
    subscriber_authorization: 'explicit_subscription';
    max_fan_out: number;
  };
  recipient_acceptance: {
    'review.request': 'required';
    'workitem.handoff': 'required';
    side_effects: 'required';
    mission_lifecycle: 'deny';
  };
}
