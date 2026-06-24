import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pathResolver, safeRmSync } from './index.js';
import {
  advertiseMeshCapabilities,
  recordMeshHeartbeat,
  registerMeshPeer,
} from './mesh-peer-directory.js';
import { routeMeshRequest } from './mesh-router.js';
import { clearMeshTopicRegistryNamespace, subscribeMeshTopic } from './mesh-topic-registry.js';
import type { MeshRequest } from './mesh-hub-contract.js';

const ROOT = pathResolver.rootDir();
const TEST_RUNTIME_ROOT = 'active/shared/runtime/mesh-hub-router-tests';
const TEST_RUNTIME_ROOT_ABS = path.join(ROOT, TEST_RUNTIME_ROOT);

function buildRequest(input: {
  requestId: string;
  selector: MeshRequest['target']['selector'];
  requestKind: MeshRequest['request_kind'];
  classification?: MeshRequest['payload']['classification'];
}): MeshRequest {
  return {
    kind: 'mesh-request',
    request_id: input.requestId,
    tenant_scope: {
      tenant_id: 'tenant-acme',
      scope: 'same_tenant',
    },
    sender_peer_id: 'peer-sender',
    created_at: '2026-06-24T00:03:00.000Z',
    ttl_ms: 60_000,
    idempotency_key: `idem-${input.requestId}`,
    correlation_id: `corr-${input.requestId}`,
    request_kind: input.requestKind,
    target: {
      selector: input.selector,
    },
    payload: {
      classification: input.classification || 'confidential',
      reference: {
        artifact_ref: 'artifact://tenant-acme/review-brief',
        integrity_hash: 'sha256:0123456789abcdef',
        storage_class: 'artifact_store',
      },
    },
  };
}

describe('mesh-router', () => {
  beforeEach(() => {
    process.env.KYBERION_MESH_HUB_RUNTIME_ROOT = TEST_RUNTIME_ROOT;
    process.env.KYBERION_MESH_HUB_OBSERVABILITY_ROOT = TEST_RUNTIME_ROOT.replace('runtime', 'observability');
    safeRmSync(TEST_RUNTIME_ROOT_ABS, { recursive: true, force: true });
    clearMeshTopicRegistryNamespace();
  });

  afterEach(() => {
    safeRmSync(TEST_RUNTIME_ROOT_ABS, { recursive: true, force: true });
    clearMeshTopicRegistryNamespace();
  });

  it('routes an exact peer only when the peer is enrolled, present, and capability-authorized', () => {
    registerMeshPeer({
      peer_id: 'peer-a1',
      tenant_id: 'tenant-acme',
      endpoint_ref: 'mesh://peer-a1.local',
      key_ref: 'vault://mesh/peer-a1/key',
      authority_role: 'infrastructure_sentinel',
      allowed_request_kinds: ['review.request'],
    });
    recordMeshHeartbeat({
      peer_id: 'peer-a1',
      tenant_id: 'tenant-acme',
      heartbeat_at: '2026-06-24T00:01:00.000Z',
      expires_at: '2026-06-24T00:06:00.000Z',
    });
    advertiseMeshCapabilities({
      peer_id: 'peer-a1',
      tenant_id: 'tenant-acme',
      capability_id: 'document.review',
      version: '1',
      roles: ['reviewer'],
      request_kinds: ['review.request'],
    });

    const decision = routeMeshRequest(
      buildRequest({
        requestId: 'req-exact-peer',
        selector: {
          kind: 'peer',
          peer_id: 'peer-a1',
        },
        requestKind: 'review.request',
      }),
      { now: '2026-06-24T00:03:00.000Z' },
    );

    expect(decision.decision).toBe('direct');
    expect(decision.selected_peer_ids).toEqual(['peer-a1']);
    expect(decision.candidates[0]).toMatchObject({
      peer_id: 'peer-a1',
      selected: true,
    });
  });

  it('requires operator selection when multiple eligible role or capability matches remain', () => {
    registerMeshPeer({
      peer_id: 'peer-a1',
      tenant_id: 'tenant-acme',
      endpoint_ref: 'mesh://peer-a1.local',
      key_ref: 'vault://mesh/peer-a1/key',
      authority_role: 'infrastructure_sentinel',
      allowed_request_kinds: ['review.request'],
    });
    registerMeshPeer({
      peer_id: 'peer-b1',
      tenant_id: 'tenant-acme',
      endpoint_ref: 'mesh://peer-b1.local',
      key_ref: 'vault://mesh/peer-b1/key',
      authority_role: 'infrastructure_sentinel',
      allowed_request_kinds: ['review.request'],
    });

    recordMeshHeartbeat({
      peer_id: 'peer-a1',
      tenant_id: 'tenant-acme',
      heartbeat_at: '2026-06-24T00:01:00.000Z',
      expires_at: '2026-06-24T00:06:00.000Z',
      capacity: {
        accepting_new_work: true,
        available_slots: 1,
        max_inflight: 2,
      },
    });
    recordMeshHeartbeat({
      peer_id: 'peer-b1',
      tenant_id: 'tenant-acme',
      heartbeat_at: '2026-06-24T00:01:00.000Z',
      expires_at: '2026-06-24T00:06:00.000Z',
      capacity: {
        accepting_new_work: true,
        available_slots: 3,
        max_inflight: 5,
      },
    });
    advertiseMeshCapabilities({
      peer_id: 'peer-a1',
      tenant_id: 'tenant-acme',
      capability_id: 'document.review',
      version: '1',
      roles: ['reviewer'],
      request_kinds: ['review.request'],
    });
    advertiseMeshCapabilities({
      peer_id: 'peer-b1',
      tenant_id: 'tenant-acme',
      capability_id: 'document.review',
      version: '1',
      roles: ['reviewer'],
      request_kinds: ['review.request'],
    });

    const decision = routeMeshRequest(
      buildRequest({
        requestId: 'req-role',
        selector: {
          kind: 'role',
          role: 'reviewer',
        },
        requestKind: 'review.request',
      }),
      { now: '2026-06-24T00:03:00.000Z' },
    );

    expect(decision.decision).toBe('requires_operator_selection');
    expect(decision.selected_peer_ids).toEqual([]);
    expect(decision.candidates.map((candidate) => candidate.peer_id)).toEqual(['peer-b1', 'peer-a1']);
    expect(decision.reason_codes).toContain('requires_operator_selection');
  });

  it('resolves explicit topic subscriptions and enforces max fan-out', () => {
    registerMeshPeer({
      peer_id: 'peer-a1',
      tenant_id: 'tenant-acme',
      endpoint_ref: 'mesh://peer-a1.local',
      key_ref: 'vault://mesh/peer-a1/key',
      authority_role: 'infrastructure_sentinel',
      allowed_request_kinds: ['notification.publish'],
    });
    registerMeshPeer({
      peer_id: 'peer-b1',
      tenant_id: 'tenant-acme',
      endpoint_ref: 'mesh://peer-b1.local',
      key_ref: 'vault://mesh/peer-b1/key',
      authority_role: 'infrastructure_sentinel',
      allowed_request_kinds: ['notification.publish'],
    });
    recordMeshHeartbeat({
      peer_id: 'peer-a1',
      tenant_id: 'tenant-acme',
      heartbeat_at: '2026-06-24T00:01:00.000Z',
      expires_at: '2026-06-24T00:06:00.000Z',
    });
    recordMeshHeartbeat({
      peer_id: 'peer-b1',
      tenant_id: 'tenant-acme',
      heartbeat_at: '2026-06-24T00:01:00.000Z',
      expires_at: '2026-06-24T00:06:00.000Z',
    });
    advertiseMeshCapabilities({
      peer_id: 'peer-a1',
      tenant_id: 'tenant-acme',
      capability_id: 'announcement.delivery',
      version: '1',
      roles: ['notifier'],
      request_kinds: ['notification.publish'],
    });
    advertiseMeshCapabilities({
      peer_id: 'peer-b1',
      tenant_id: 'tenant-acme',
      capability_id: 'announcement.delivery',
      version: '1',
      roles: ['notifier'],
      request_kinds: ['notification.publish'],
    });

    subscribeMeshTopic(
      {
        subscription_id: 'sub-a1',
        tenant_id: 'tenant-acme',
        topic: 'release.review',
        peer_id: 'peer-a1',
        filters: {
          request_kinds: ['notification.publish'],
          payload_classifications: ['public'],
        },
        expires_at: '2026-06-24T01:03:00.000Z',
        policy_version: '1.0.0',
        authority_role: 'infrastructure_sentinel',
      },
      { namespace: '' },
    );
    subscribeMeshTopic(
      {
        subscription_id: 'sub-b1',
        tenant_id: 'tenant-acme',
        topic: 'release.review',
        peer_id: 'peer-b1',
        filters: {
          request_kinds: ['notification.publish'],
          payload_classifications: ['public'],
        },
        expires_at: '2026-06-24T01:03:00.000Z',
        policy_version: '1.0.0',
        authority_role: 'infrastructure_sentinel',
      },
      { namespace: '' },
    );

    const decision = routeMeshRequest(
      buildRequest({
        requestId: 'req-topic',
        selector: {
          kind: 'topic',
          topic: 'release.review',
        },
        requestKind: 'notification.publish',
        classification: 'public',
      }),
      {
        now: '2026-06-24T00:03:00.000Z',
        maxFanOut: 2,
      },
    );

    expect(decision.decision).toBe('fan_out');
    expect(decision.selected_peer_ids).toEqual(['peer-a1', 'peer-b1']);
    expect(decision.topic_resolution?.selected_peer_ids).toEqual(['peer-a1', 'peer-b1']);
    expect(decision.topic_resolution?.candidates).toHaveLength(2);

    const rejectedDecision = routeMeshRequest(
      buildRequest({
        requestId: 'req-topic-limit',
        selector: {
          kind: 'topic',
          topic: 'release.review',
        },
        requestKind: 'notification.publish',
        classification: 'public',
      }),
      {
        now: '2026-06-24T00:03:00.000Z',
        maxFanOut: 1,
      },
    );

    expect(rejectedDecision.decision).toBe('rejected');
    expect(rejectedDecision.reason_codes).toContain('fan_out_limit_exceeded');
  });
});
