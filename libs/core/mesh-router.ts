import { safeReadFile } from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import {
  listEligibleMeshPeers,
  listMeshPeerDirectoryEntries,
  type MeshPeerDirectoryEntry,
} from './mesh-peer-directory.js';
import {
  resolveMeshTopicRecipients,
  type MeshTopicResolution,
} from './mesh-topic-registry.js';
import type {
  MeshRequest,
  MeshRequestKind,
  MeshTargetSelector,
} from './mesh-hub-contract.js';

const DEFAULT_POLICY_VERSION = '1.0.0';

export interface MeshRouteCandidate {
  peer_id: string;
  tenant_id: string;
  status: MeshPeerDirectoryEntry['status'];
  rank: number;
  reasons: string[];
  capabilities: string[];
  selected?: boolean;
}

export interface MeshRouteExclusion {
  peer_id: string;
  reason: string;
}

export interface MeshRouteDecision {
  kind: 'mesh-route-decision';
  request_id: string;
  tenant_id: string;
  request_kind: MeshRequestKind;
  selector: MeshTargetSelector;
  policy_version: string;
  decision: 'direct' | 'fan_out' | 'requires_operator_selection' | 'no_eligible_peer' | 'rejected';
  selected_peer_ids: string[];
  candidates: MeshRouteCandidate[];
  exclusions: MeshRouteExclusion[];
  reason_codes: string[];
  topic_resolution?: MeshTopicResolution;
}

export interface MeshRouteOptions {
  now?: string | Date;
  namespace?: string;
  policyVersion?: string;
  maxFanOut?: number;
}

interface MeshHubPolicySnapshot {
  version: string;
  routing?: {
    automatic_peer_selection?: 'deny';
    load_signals?: string[];
  };
  topic_delivery?: {
    max_fan_out?: number;
  };
}

function normalizeIso(value?: string | Date): string {
  const input = value ?? new Date();
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid_iso_timestamp:${String(value)}`);
  }
  return date.toISOString();
}

function loadMeshHubPolicy(): MeshHubPolicySnapshot {
  const policyPath = pathResolver.resolve('knowledge/product/governance/mesh-hub-policy.json');
  return JSON.parse(String(safeReadFile(policyPath, { encoding: 'utf8' }) || '{}')) as MeshHubPolicySnapshot;
}

function normalizeRequestKind(value: string): MeshRequestKind | null {
  const valid = [
    'review.request',
    'workitem.claim',
    'workitem.handoff',
    'workitem.status_update',
    'capability.query',
    'notification.publish',
  ] as const;
  return (valid as readonly string[]).includes(value) ? (value as MeshRequestKind) : null;
}

function scorePeer(entry: MeshPeerDirectoryEntry): number {
  const presence = entry.presence;
  const healthScore = presence
    ? {
        healthy: 4,
        degraded: 3,
        maintenance: 2,
        unhealthy: 1,
      }[presence.health]
    : 0;
  const acceptingScore = presence?.capacity.accepting_new_work ? 2 : 0;
  const slotScore = Math.max(0, presence?.capacity.available_slots || 0);
  const inflightScore = Math.max(0, presence?.capacity.max_inflight || 0);
  return healthScore * 100 + acceptingScore * 10 + slotScore + inflightScore / 10;
}

function candidateReasons(entry: MeshPeerDirectoryEntry, requestKind: MeshRequestKind): string[] {
  const reasons = ['same_tenant', 'enrolled', 'presence_fresh'];
  if (entry.presence?.capacity.accepting_new_work) reasons.push('accepting_new_work');
  reasons.push(`request_kind:${requestKind}`);
  return reasons;
}

function topicResolutionToRouteDecision(
  request: MeshRequest,
  resolution: MeshTopicResolution,
  policyVersion: string,
): MeshRouteDecision {
  const selected_peer_ids = [...resolution.selected_peer_ids];
  return {
    kind: 'mesh-route-decision',
    request_id: request.request_id,
    tenant_id: request.tenant_scope.tenant_id,
    request_kind: request.request_kind,
    selector: request.target.selector,
    policy_version: policyVersion,
    decision: resolution.decision,
    selected_peer_ids,
    candidates: resolution.candidates.map((candidate, index) => ({
      peer_id: candidate.peer_id,
      tenant_id: request.tenant_scope.tenant_id,
      status: 'enrolled',
      rank: index + 1,
      reasons: candidate.reasons,
      capabilities: [],
      selected: selected_peer_ids.includes(candidate.peer_id),
    })),
    exclusions: resolution.exclusions.map((exclusion) => ({
      peer_id: exclusion.peer_id,
      reason: exclusion.reason,
    })),
    reason_codes: resolution.reason_codes,
    topic_resolution: resolution,
  };
}

function buildDirectRouteDecision(
  request: MeshRequest,
  selector: MeshTargetSelector,
  eligiblePeers: MeshPeerDirectoryEntry[],
  policyVersion: string,
  exclusions: MeshRouteExclusion[],
): MeshRouteDecision {
  const ranked = eligiblePeers
    .slice()
    .sort((left, right) => {
      const rankDelta = scorePeer(right) - scorePeer(left);
      if (rankDelta !== 0) return rankDelta;
      return left.peer_id.localeCompare(right.peer_id);
    });
  const selectedPeer = ranked[0] || null;
  const decision = ranked.length > 1 ? 'requires_operator_selection' : 'direct';
  return {
    kind: 'mesh-route-decision',
    request_id: request.request_id,
    tenant_id: request.tenant_scope.tenant_id,
    request_kind: request.request_kind,
    selector,
    policy_version: policyVersion,
    decision: selectedPeer ? decision : 'no_eligible_peer',
    selected_peer_ids: selectedPeer && decision === 'direct' ? [selectedPeer.peer_id] : [],
    candidates: ranked.map((entry, index) => ({
      peer_id: entry.peer_id,
      tenant_id: entry.tenant_id || request.tenant_scope.tenant_id,
      status: entry.status,
      rank: index + 1,
      reasons: candidateReasons(entry, request.request_kind),
      capabilities: entry.capabilities.map((capability) => capability.capability_id),
      selected: decision === 'direct' && index === 0,
    })),
    exclusions,
    reason_codes: selectedPeer
      ? (decision === 'direct' ? ['direct_recipient_selected'] : ['requires_operator_selection'])
      : ['no_eligible_peer'],
  };
}

function collectPeerExclusions(
  entries: MeshPeerDirectoryEntry[],
  eligiblePeerIds: Set<string>,
  tenantId: string,
  requestKind: MeshRequestKind,
): MeshRouteExclusion[] {
  return entries
    .filter((entry) => !eligiblePeerIds.has(entry.peer_id))
    .map((entry) => {
      if (!entry.tenant_id) {
        return { peer_id: entry.peer_id, reason: 'missing_tenant' };
      }
      if (entry.tenant_id !== tenantId) {
        return { peer_id: entry.peer_id, reason: 'tenant_mismatch' };
      }
      if (!entry.presence) {
        return { peer_id: entry.peer_id, reason: 'presence_stale' };
      }
      if (entry.status !== 'enrolled') {
        return { peer_id: entry.peer_id, reason: `status_${entry.status}` };
      }
      const requestAuthorized = entry.capabilities.some((capability) => capability.request_kinds.includes(requestKind));
      if (!requestAuthorized) {
        return { peer_id: entry.peer_id, reason: 'request_kind_not_authorized' };
      }
      return { peer_id: entry.peer_id, reason: 'selector_mismatch' };
    });
}

export function routeMeshRequest(request: MeshRequest, options: MeshRouteOptions = {}): MeshRouteDecision {
  const policy = loadMeshHubPolicy();
  const policyVersion = options.policyVersion || policy.version || DEFAULT_POLICY_VERSION;
  const now = normalizeIso(options.now);
  const selector = request.target.selector;

  if (!normalizeRequestKind(request.request_kind)) {
    throw new Error(`unsupported_mesh_request_kind:${request.request_kind}`);
  }

  if (selector.kind === 'topic') {
    const resolution = resolveMeshTopicRecipients(
      {
        tenant_id: request.tenant_scope.tenant_id,
        topic: selector.topic,
        request_kind: request.request_kind,
        payload_classification: request.payload.classification,
        now,
      },
      {
        namespace: options.namespace,
        maxFanOut: options.maxFanOut || policy.topic_delivery?.max_fan_out || 1,
        policyVersion,
      },
    );
    return topicResolutionToRouteDecision(request, resolution, policyVersion);
  }

  const directoryEntries = listMeshPeerDirectoryEntries(now);
  const eligiblePeers = listEligibleMeshPeers(selector, {
    tenant_id: request.tenant_scope.tenant_id,
    now,
    request_kind: request.request_kind,
  });
  const eligiblePeerIds = new Set(eligiblePeers.map((peer) => peer.peer_id));
  const exclusions = collectPeerExclusions(directoryEntries, eligiblePeerIds, request.tenant_scope.tenant_id, request.request_kind);

  if (selector.kind === 'peer') {
    const exact = eligiblePeers.filter((peer) => peer.peer_id === selector.peer_id);
    if (!exact.length) {
      return {
        kind: 'mesh-route-decision',
        request_id: request.request_id,
        tenant_id: request.tenant_scope.tenant_id,
        request_kind: request.request_kind,
        selector,
        policy_version: policyVersion,
        decision: 'no_eligible_peer',
        selected_peer_ids: [],
        candidates: [],
        exclusions,
        reason_codes: ['peer_not_eligible'],
      };
    }
    return buildDirectRouteDecision(request, selector, exact, policyVersion, exclusions);
  }

  if (selector.kind === 'role' || selector.kind === 'capability') {
    if (!eligiblePeers.length) {
      return {
        kind: 'mesh-route-decision',
        request_id: request.request_id,
        tenant_id: request.tenant_scope.tenant_id,
        request_kind: request.request_kind,
        selector,
        policy_version: policyVersion,
        decision: 'no_eligible_peer',
        selected_peer_ids: [],
        candidates: [],
        exclusions,
        reason_codes: ['no_eligible_peer'],
      };
    }
    return buildDirectRouteDecision(request, selector, eligiblePeers, policyVersion, exclusions);
  }

  return {
    kind: 'mesh-route-decision',
    request_id: request.request_id,
    tenant_id: request.tenant_scope.tenant_id,
    request_kind: request.request_kind,
    selector,
    policy_version: policyVersion,
    decision: 'rejected',
    selected_peer_ids: [],
    candidates: [],
    exclusions,
    reason_codes: ['unsupported_selector'],
  };
}
