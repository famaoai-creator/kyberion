import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pathResolver, safeRmSync } from './index.js';
import {
  advertiseMeshCapabilities,
  recordMeshHeartbeat,
  registerMeshPeer,
} from './mesh-peer-directory.js';
import {
  listMeshTopicSubscriptions,
  clearMeshTopicRegistryNamespace,
  resolveMeshTopicRecipients,
  subscribeMeshTopic,
} from './mesh-topic-registry.js';

const ROOT = pathResolver.rootDir();
const TEST_RUNTIME_ROOT = 'active/shared/runtime/mesh-hub-topic-tests';
const TEST_RUNTIME_ROOT_ABS = path.join(ROOT, TEST_RUNTIME_ROOT);

describe('mesh-topic-registry', () => {
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

  it('stores explicit subscriptions and rejects unauthorized subscription authorities', () => {
    expect(() =>
      subscribeMeshTopic({
        tenant_id: 'tenant-acme',
        topic: 'release.review',
        peer_id: 'peer-a1',
        filters: {
          request_kinds: ['notification.publish'],
          payload_classifications: ['public'],
        },
        expires_at: '2026-06-24T01:03:00.000Z',
        policy_version: '1.0.0',
        authority_role: 'slack_bridge' as any,
      }),
    ).toThrow(/topic_subscription_authority_denied/i);

    const subscription = subscribeMeshTopic({
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

    expect(subscription.kind).toBe('mesh-topic-subscription');
    expect(subscription.subscription_id).toBe('sub-a1');
    expect(
      listMeshTopicSubscriptions({
        tenant_id: 'tenant-acme',
        topic: 'release.review',
        peer_id: 'peer-a1',
      }, { now: '2026-06-24T00:03:00.000Z' }),
    ).toHaveLength(1);
  });

  it('resolves only explicitly subscribed and currently eligible peers', () => {
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
    subscribeMeshTopic({
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
    });

    const resolution = resolveMeshTopicRecipients({
      tenant_id: 'tenant-acme',
      topic: 'release.review',
      request_kind: 'notification.publish',
      payload_classification: 'public',
      now: '2026-06-24T00:03:00.000Z',
    }, { maxFanOut: 2 });

    expect(resolution.decision).toBe('fan_out');
    expect(resolution.selected_peer_ids).toEqual(['peer-a1', 'peer-b1']);
    expect(resolution.candidates.map((candidate) => candidate.peer_id)).toEqual(['peer-a1', 'peer-b1']);
    expect(resolution.exclusions).toEqual([]);
  });

  it('enforces max fan-out at resolution time', () => {
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
    subscribeMeshTopic({
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
    });

    const resolution = resolveMeshTopicRecipients(
      {
        tenant_id: 'tenant-acme',
        topic: 'release.review',
        request_kind: 'notification.publish',
        payload_classification: 'public',
        now: '2026-06-24T00:03:00.000Z',
      },
      {
        maxFanOut: 1,
      },
    );

    expect(resolution.decision).toBe('rejected');
    expect(resolution.reason_codes).toContain('fan_out_limit_exceeded');
  });
});
