import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pathResolver, safeRmSync } from './index.js';
import {
  advertiseMeshCapabilities,
  recordMeshHeartbeat,
  registerMeshPeer,
} from './mesh-peer-directory.js';
import {
  clearMeshMessageBrokerNamespace,
  createMeshMessageBroker,
} from './mesh-message-broker.js';
import {
  formatMeshHubInspectionReport,
  inspectMeshHub,
} from './mesh-hub-inspection.js';
import { clearMeshTopicRegistryNamespace, subscribeMeshTopic } from './mesh-topic-registry.js';
import type { MeshRequest } from './mesh-hub-contract.js';

const ROOT = pathResolver.rootDir();
const TEST_RUNTIME_ROOT = 'active/shared/runtime/mesh-hub-inspection-tests';
const TEST_RUNTIME_ROOT_ABS = path.join(ROOT, TEST_RUNTIME_ROOT);

function buildRequest(requestId: string): MeshRequest {
  return {
    kind: 'mesh-request',
    request_id: requestId,
    tenant_scope: {
      tenant_id: 'tenant-acme',
      scope: 'same_tenant',
    },
    sender_peer_id: 'peer-sender',
    created_at: '2026-06-24T00:03:00.000Z',
    ttl_ms: 60_000,
    idempotency_key: `idem-${requestId}`,
    correlation_id: `corr-${requestId}`,
    request_kind: 'review.request',
    target: {
      selector: {
        kind: 'peer',
        peer_id: 'peer-a1',
      },
    },
    payload: {
      classification: 'confidential',
      reference: {
        artifact_ref: 'artifact://tenant-acme/review-brief',
        integrity_hash: 'sha256:0123456789abcdef',
        storage_class: 'artifact_store',
      },
    },
  };
}

describe('mesh-hub-inspection', () => {
  let broker: ReturnType<typeof createMeshMessageBroker> | null = null;

  beforeEach(() => {
    process.env.KYBERION_MESH_HUB_RUNTIME_ROOT = TEST_RUNTIME_ROOT;
    process.env.KYBERION_MESH_HUB_OBSERVABILITY_ROOT = TEST_RUNTIME_ROOT.replace('runtime', 'observability');
    safeRmSync(TEST_RUNTIME_ROOT_ABS, { recursive: true, force: true });
    clearMeshMessageBrokerNamespace();
    clearMeshTopicRegistryNamespace();
    broker = null;
  });

  afterEach(() => {
    broker?.close();
    broker = null;
    clearMeshMessageBrokerNamespace();
    clearMeshTopicRegistryNamespace();
    safeRmSync(TEST_RUNTIME_ROOT_ABS, { recursive: true, force: true });
  });

  it('reports healthy peers, expired peers, dead letters, routes, and topics', async () => {
    registerMeshPeer({
      peer_id: 'peer-a1',
      tenant_id: 'tenant-acme',
      endpoint_ref: 'mesh://peer-a1.local',
      key_ref: 'vault://mesh/peer-a1/key',
      authority_role: 'infrastructure_sentinel',
      allowed_request_kinds: ['review.request', 'notification.publish'],
    });
    registerMeshPeer({
      peer_id: 'peer-b1',
      tenant_id: 'tenant-acme',
      endpoint_ref: 'mesh://peer-b1.local',
      key_ref: 'vault://mesh/peer-b1/key',
      authority_role: 'infrastructure_sentinel',
      allowed_request_kinds: ['review.request', 'notification.publish'],
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
      expires_at: '2026-06-24T00:02:00.000Z',
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
      peer_id: 'peer-a1',
      tenant_id: 'tenant-acme',
      capability_id: 'announcement.delivery',
      version: '1',
      roles: ['notifier'],
      request_kinds: ['notification.publish'],
    });
    subscribeMeshTopic({
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
    });

    broker = createMeshMessageBroker({ namespace: '' });
    const accepted = await broker.acceptMeshRequest(buildRequest('meshreq-inspect'), {
      now: '2026-06-24T00:03:00.000Z',
    });
    await broker.retryMeshDelivery(accepted.delivery.delivery_id, '2026-06-24T00:03:00.000Z', {
      max_attempts: 1,
    });

    const report = await inspectMeshHub({
      now: '2026-06-24T00:03:00.000Z',
    });

    expect(report.peers.some((peer) => peer.peer_id === 'peer-a1' && peer.heartbeat_state === 'healthy')).toBe(true);
    expect(report.peers.some((peer) => peer.peer_id === 'peer-b1' && peer.heartbeat_state === 'expired')).toBe(true);
    expect(report.routes.some((route) => route.delivery_id === accepted.delivery.delivery_id && route.route_explanation.includes('peer:peer-a1'))).toBe(true);
    expect(report.dead_letters.some((deadLetter) => deadLetter.delivery_id === accepted.delivery.delivery_id)).toBe(true);
    expect(report.topics.some((topic) => topic.topic === 'release.review' && topic.fan_out_count === 1)).toBe(true);

    const rendered = formatMeshHubInspectionReport(report);
    expect(rendered.join('\n')).toContain('peer-a1');
    expect(rendered.join('\n')).toContain('expired');
    expect(rendered.join('\n')).toContain('Dead letters');
  });
});
