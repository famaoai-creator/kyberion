import * as crypto from 'node:crypto';

import { appendGovernedArtifactJsonl, type GovernedArtifactRole } from './artifact-store.js';
import { withExecutionContext } from './authority.js';
import { safeExistsSync, safeReadFile, safeRmSync } from './secure-io.js';
import { listEligibleMeshPeers } from './mesh-peer-directory.js';
import type {
  MeshPayloadClassification,
  MeshRequestKind,
  MeshTopicSubscription,
} from './mesh-hub-contract.js';

const DEFAULT_RUNTIME_ROOT = 'active/shared/runtime/mesh-hub';
const DEFAULT_OBSERVABILITY_ROOT = 'active/shared/observability/mesh-hub';
const DEFAULT_POLICY_VERSION = '1.0.0';
const DEFAULT_WRITER_ROLE: GovernedArtifactRole = 'infrastructure_sentinel';
const ALLOWED_SUBSCRIPTION_AUTHORITIES = new Set<GovernedArtifactRole>(['infrastructure_sentinel', 'mission_controller']);

export interface MeshTopicRegistryPolicyContext {
  tenant_id: string;
  topic: string;
  request_kind: MeshRequestKind;
  payload_classification: MeshPayloadClassification;
  now?: string | Date;
}

export interface MeshTopicSubscriptionInput {
  subscription_id?: string;
  tenant_id: string;
  topic: string;
  peer_id: string;
  filters: {
    request_kinds: MeshRequestKind[];
    payload_classifications: MeshPayloadClassification[];
  };
  expires_at: string | Date;
  policy_version?: string;
  authority_role: GovernedArtifactRole;
}

export interface MeshTopicResolutionCandidate {
  peer_id: string;
  subscription_id: string;
  topic: string;
  reasons: string[];
}

export interface MeshTopicResolutionExclusion {
  peer_id: string;
  subscription_id?: string;
  reason: string;
}

export interface MeshTopicResolution {
  kind: 'mesh-topic-resolution';
  tenant_id: string;
  topic: string;
  request_kind: MeshRequestKind;
  payload_classification: MeshPayloadClassification;
  policy_version: string;
  decision: 'direct' | 'fan_out' | 'no_eligible_peer' | 'rejected';
  selected_peer_ids: string[];
  candidates: MeshTopicResolutionCandidate[];
  exclusions: MeshTopicResolutionExclusion[];
  reason_codes: string[];
  fan_out_limit: number;
  resolved_at: string;
}

export interface MeshTopicSubscriptionFilter {
  tenant_id?: string;
  topic?: string;
  peer_id?: string;
}

export interface MeshTopicResolutionOptions {
  namespace?: string;
  maxFanOut?: number;
  policyVersion?: string;
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

function normalizeNamespace(namespace?: string): string {
  return String(namespace || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function meshHubRuntimeRoot(namespace?: string): string {
  const baseRoot = process.env.KYBERION_MESH_HUB_RUNTIME_ROOT || DEFAULT_RUNTIME_ROOT;
  const suffix = normalizeNamespace(namespace);
  return suffix ? `${baseRoot}/${suffix}` : baseRoot;
}

function meshHubObservabilityRoot(namespace?: string): string {
  const baseRoot = process.env.KYBERION_MESH_HUB_OBSERVABILITY_ROOT || DEFAULT_OBSERVABILITY_ROOT;
  const suffix = normalizeNamespace(namespace);
  return suffix ? `${baseRoot}/${suffix}` : baseRoot;
}

function subscriptionsPath(namespace?: string): string {
  return `${meshHubRuntimeRoot(namespace)}/subscriptions.jsonl`;
}

function eventsPath(namespace?: string): string {
  return `${meshHubObservabilityRoot(namespace)}/events.jsonl`;
}

function randomId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function readJsonl<T>(logicalPath: string): T[] {
  if (!safeExistsSync(logicalPath)) return [];
  const raw = String(safeReadFile(logicalPath, { encoding: 'utf8' }) || '');
  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function appendRecord(role: GovernedArtifactRole, logicalPath: string, record: unknown): string {
  return appendGovernedArtifactJsonl(role, logicalPath, record);
}

function recordEvent(namespace: string | undefined, event: Record<string, unknown>): string {
  return appendRecord(DEFAULT_WRITER_ROLE, eventsPath(namespace), {
    ts: nowIso(),
    ...event,
  });
}

function loadSubscriptions(namespace?: string): MeshTopicSubscription[] {
  return readJsonl<MeshTopicSubscription>(subscriptionsPath(namespace));
}

function normalizeSubscription(input: MeshTopicSubscriptionInput): MeshTopicSubscription {
  const subscription_id = String(input.subscription_id || '').trim() || randomId('mts');
  const tenant_id = String(input.tenant_id || '').trim();
  const topic = String(input.topic || '').trim();
  const peer_id = String(input.peer_id || '').trim();
  if (!tenant_id || !topic || !peer_id) {
    throw new Error('topic_subscription_missing_required_fields');
  }
  if (!ALLOWED_SUBSCRIPTION_AUTHORITIES.has(input.authority_role)) {
    throw new Error(`topic_subscription_authority_denied:${input.authority_role}`);
  }
  if (!input.filters.request_kinds?.length || !input.filters.payload_classifications?.length) {
    throw new Error('topic_subscription_missing_filters');
  }
  return {
    kind: 'mesh-topic-subscription',
    subscription_id,
    tenant_id,
    topic,
    peer_id,
    filters: {
      request_kinds: [...new Set(input.filters.request_kinds)],
      payload_classifications: [...new Set(input.filters.payload_classifications)],
    },
    expires_at: normalizeIso(input.expires_at),
    policy_version: String(input.policy_version || DEFAULT_POLICY_VERSION),
  };
}

function isActiveSubscription(subscription: MeshTopicSubscription, now: string): boolean {
  return subscription.expires_at > now;
}

function matchesSubscription(
  subscription: MeshTopicSubscription,
  context: MeshTopicRegistryPolicyContext,
): boolean {
  return (
    subscription.tenant_id === context.tenant_id &&
    subscription.topic === context.topic &&
    subscription.filters.request_kinds.includes(context.request_kind) &&
    subscription.filters.payload_classifications.includes(context.payload_classification)
  );
}

export function subscribeMeshTopic(input: MeshTopicSubscriptionInput, options: { namespace?: string } = {}): MeshTopicSubscription {
  const subscription = normalizeSubscription(input);
  const namespace = options.namespace || '';
  appendRecord(DEFAULT_WRITER_ROLE, subscriptionsPath(namespace), subscription);
  recordEvent(namespace, {
    type: 'topic_subscription_created',
    subscription_id: subscription.subscription_id,
    tenant_id: subscription.tenant_id,
    topic: subscription.topic,
    peer_id: subscription.peer_id,
    request_kinds: subscription.filters.request_kinds,
    payload_classifications: subscription.filters.payload_classifications,
    policy_version: subscription.policy_version,
  });
  return subscription;
}

export function listMeshTopicSubscriptions(
  filter: MeshTopicSubscriptionFilter = {},
  options: { namespace?: string; now?: string | Date } = {},
): MeshTopicSubscription[] {
  const namespace = options.namespace || '';
  const now = normalizeIso(options.now);
  return loadSubscriptions(namespace)
    .filter((subscription) => isActiveSubscription(subscription, now))
    .filter((subscription) => {
      if (filter.tenant_id && subscription.tenant_id !== filter.tenant_id) return false;
      if (filter.topic && subscription.topic !== filter.topic) return false;
      if (filter.peer_id && subscription.peer_id !== filter.peer_id) return false;
      return true;
    })
    .sort((left, right) => left.subscription_id.localeCompare(right.subscription_id));
}

export function resolveMeshTopicRecipients(
  context: MeshTopicRegistryPolicyContext,
  options: MeshTopicResolutionOptions = {},
): MeshTopicResolution {
  const namespace = options.namespace || '';
  const policyVersion = options.policyVersion || DEFAULT_POLICY_VERSION;
  const fanOutLimit = Math.max(1, Math.floor(options.maxFanOut || 1));
  const now = normalizeIso(context.now);

  const subscriptions = loadSubscriptions(namespace)
    .filter((subscription) => isActiveSubscription(subscription, now))
    .filter((subscription) => matchesSubscription(subscription, context))
    .sort((left, right) => left.subscription_id.localeCompare(right.subscription_id));

  const candidates: MeshTopicResolutionCandidate[] = [];
  const exclusions: MeshTopicResolutionExclusion[] = [];
  const selected_peer_ids: string[] = [];
  const seenPeers = new Set<string>();

  for (const subscription of subscriptions) {
    if (seenPeers.has(subscription.peer_id)) {
      exclusions.push({
        peer_id: subscription.peer_id,
        subscription_id: subscription.subscription_id,
        reason: 'duplicate_subscription_peer',
      });
      continue;
    }

    const eligiblePeers = listEligibleMeshPeers(
      {
        kind: 'peer',
        peer_id: subscription.peer_id,
      },
      {
        tenant_id: context.tenant_id,
        now,
        request_kind: context.request_kind,
      },
    );

    if (!eligiblePeers.length) {
      exclusions.push({
        peer_id: subscription.peer_id,
        subscription_id: subscription.subscription_id,
        reason: 'subscriber_not_eligible',
      });
      continue;
    }

    const peer = eligiblePeers[0];
    seenPeers.add(peer.peer_id);
    selected_peer_ids.push(peer.peer_id);
    candidates.push({
      peer_id: peer.peer_id,
      subscription_id: subscription.subscription_id,
      topic: subscription.topic,
      reasons: [
        'explicit_subscription',
        'same_tenant',
        'presence_fresh',
        `request_kind:${context.request_kind}`,
        `payload_classification:${context.payload_classification}`,
      ],
    });
  }

  if (!selected_peer_ids.length) {
    return {
      kind: 'mesh-topic-resolution',
      tenant_id: context.tenant_id,
      topic: context.topic,
      request_kind: context.request_kind,
      payload_classification: context.payload_classification,
      policy_version: policyVersion,
      decision: 'no_eligible_peer',
      selected_peer_ids: [],
      candidates,
      exclusions,
      reason_codes: ['no_explicit_subscription'],
      fan_out_limit: fanOutLimit,
      resolved_at: now,
    };
  }

  if (selected_peer_ids.length > fanOutLimit) {
    recordEvent(namespace, {
      type: 'topic_publish_rejected',
      topic: context.topic,
      tenant_id: context.tenant_id,
      request_kind: context.request_kind,
      payload_classification: context.payload_classification,
      fan_out_limit: fanOutLimit,
      selected_peer_ids,
    });
    return {
      kind: 'mesh-topic-resolution',
      tenant_id: context.tenant_id,
      topic: context.topic,
      request_kind: context.request_kind,
      payload_classification: context.payload_classification,
      policy_version: policyVersion,
      decision: 'rejected',
      selected_peer_ids: [],
      candidates,
      exclusions: [
        ...exclusions,
        {
          peer_id: 'topic-fan-out',
          reason: 'fan_out_limit_exceeded',
        },
      ],
      reason_codes: ['fan_out_limit_exceeded'],
      fan_out_limit: fanOutLimit,
      resolved_at: now,
    };
  }

  const decision = selected_peer_ids.length === 1 ? 'direct' : 'fan_out';
  recordEvent(namespace, {
    type: 'topic_publish_resolved',
    topic: context.topic,
    tenant_id: context.tenant_id,
    request_kind: context.request_kind,
    payload_classification: context.payload_classification,
    decision,
    selected_peer_ids,
    fan_out_limit: fanOutLimit,
  });

  return {
    kind: 'mesh-topic-resolution',
    tenant_id: context.tenant_id,
    topic: context.topic,
    request_kind: context.request_kind,
    payload_classification: context.payload_classification,
    policy_version: policyVersion,
    decision,
    selected_peer_ids,
    candidates,
    exclusions,
    reason_codes: decision === 'fan_out' ? ['explicit_subscription', 'fan_out'] : ['explicit_subscription'],
    fan_out_limit: fanOutLimit,
    resolved_at: now,
  };
}

export function clearMeshTopicRegistryNamespace(namespace?: string): void {
  const normalized = normalizeNamespace(namespace);
  const root = normalized ? `${meshHubRuntimeRoot(normalized)}` : meshHubRuntimeRoot();
  const obsRoot = normalized ? `${meshHubObservabilityRoot(normalized)}` : meshHubObservabilityRoot();
  withExecutionContext(DEFAULT_WRITER_ROLE, () => {
    if (safeExistsSync(root)) safeRmSync(root, { recursive: true, force: true });
    if (safeExistsSync(obsRoot)) safeRmSync(obsRoot, { recursive: true, force: true });
  });
}
