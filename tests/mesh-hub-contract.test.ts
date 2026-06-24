import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { safeExistsSync, safeReadFile } from '@agent/core/secure-io';

import {
  MESH_DELIVERY_STATUSES,
  MESH_FAILURE_CLASSES,
  MESH_PAYLOAD_CLASSIFICATIONS,
  MESH_RECEIVE_MODES,
  MESH_REQUEST_KINDS,
  MESH_SELECTOR_KINDS,
  isMeshPayloadClassification,
  isMeshRequestKind,
  isMeshSelectorKind,
  isMeshTopicVisibility,
} from '../libs/core/mesh-hub-contract.js';

function loadJson(filePath: string) {
  return JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string);
}

function makeAjv() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv;
}

describe('Mesh Hub contract', () => {
  it('exposes a closed selector and request vocabulary', () => {
    expect(MESH_SELECTOR_KINDS).toEqual(['peer', 'role', 'capability', 'topic']);
    expect(MESH_REQUEST_KINDS).toEqual([
      'review.request',
      'workitem.claim',
      'workitem.handoff',
      'workitem.status_update',
      'capability.query',
      'notification.publish',
    ]);
    expect(MESH_PAYLOAD_CLASSIFICATIONS).toEqual(['public', 'confidential']);
    expect(MESH_DELIVERY_STATUSES).toEqual([
      'accepted',
      'queued',
      'dispatched',
      'acknowledged',
      'completed',
      'rejected',
      'expired',
      'dead_lettered',
    ]);
    expect(MESH_FAILURE_CLASSES).toEqual([
      'transport_error',
      'policy_denied',
      'expired',
      'recipient_rejected',
      'dead_lettered',
    ]);
    expect(MESH_RECEIVE_MODES).toEqual(['request', 'topic', 'capability_query', 'workitem']);
    expect(isMeshSelectorKind('peer')).toBe(true);
    expect(isMeshSelectorKind('broadcast')).toBe(false);
    expect(isMeshRequestKind('workitem.handoff')).toBe(true);
    expect(isMeshRequestKind('mission.start')).toBe(false);
    expect(isMeshPayloadClassification('confidential')).toBe(true);
    expect(isMeshPayloadClassification('personal')).toBe(false);
    expect(isMeshTopicVisibility('tenant')).toBe(true);
    expect(isMeshTopicVisibility('public')).toBe(false);
  });

  it('ships the expected mesh hub schema files', () => {
    expect(safeExistsSync('knowledge/product/schemas/mesh-peer-registration.schema.json')).toBe(true);
    expect(safeExistsSync('knowledge/product/schemas/mesh-peer-presence.schema.json')).toBe(true);
    expect(safeExistsSync('knowledge/product/schemas/mesh-capability-advertisement.schema.json')).toBe(true);
    expect(safeExistsSync('knowledge/product/schemas/mesh-request.schema.json')).toBe(true);
    expect(safeExistsSync('knowledge/product/schemas/mesh-delivery-record.schema.json')).toBe(true);
    expect(safeExistsSync('knowledge/product/schemas/mesh-topic-subscription.schema.json')).toBe(true);
    expect(safeExistsSync('knowledge/product/governance/mesh-hub-policy.json')).toBe(true);
  });

  it('validates representative peer, presence, capability, request, delivery, and subscription contracts', () => {
    const ajv = makeAjv();
    const peerRegistrationSchema = loadJson('knowledge/product/schemas/mesh-peer-registration.schema.json');
    const peerPresenceSchema = loadJson('knowledge/product/schemas/mesh-peer-presence.schema.json');
    const capabilitySchema = loadJson('knowledge/product/schemas/mesh-capability-advertisement.schema.json');
    const requestSchema = loadJson('knowledge/product/schemas/mesh-request.schema.json');
    const deliverySchema = loadJson('knowledge/product/schemas/mesh-delivery-record.schema.json');
    const subscriptionSchema = loadJson('knowledge/product/schemas/mesh-topic-subscription.schema.json');

    const validatePeerRegistration = ajv.compile(peerRegistrationSchema);
    const validatePeerPresence = ajv.compile(peerPresenceSchema);
    const validateCapability = ajv.compile(capabilitySchema);
    const validateRequest = ajv.compile(requestSchema);
    const validateDelivery = ajv.compile(deliverySchema);
    const validateSubscription = ajv.compile(subscriptionSchema);

    expect(
      validatePeerRegistration({
        kind: 'mesh-peer-registration',
        peer_id: 'peer-a1',
        tenant_id: 'tenant-acme',
        endpoint_ref: 'mesh://peer-a1.local',
        key_ref: 'vault://mesh/peer-a1/key',
        status: 'enrolled',
        registered_at: '2026-06-24T00:00:00.000Z',
        allowed_request_kinds: ['review.request', 'capability.query'],
      }),
      ajv.errorsText(validatePeerRegistration.errors),
    ).toBe(true);

    expect(
      validatePeerPresence({
        kind: 'mesh-peer-presence',
        peer_id: 'peer-a1',
        tenant_id: 'tenant-acme',
        heartbeat_at: '2026-06-24T00:01:00.000Z',
        expires_at: '2026-06-24T00:06:00.000Z',
        health: 'healthy',
        capacity: {
          accepting_new_work: true,
          available_slots: 3,
          max_inflight: 6,
        },
        receive_modes: ['request', 'topic'],
      }),
      ajv.errorsText(validatePeerPresence.errors),
    ).toBe(true);

    expect(
      validateCapability({
        kind: 'mesh-capability-advertisement',
        capability_id: 'document.review',
        version: '1',
        peer_id: 'peer-a1',
        tenant_id: 'tenant-acme',
        roles: ['reviewer'],
        request_kinds: ['review.request', 'workitem.handoff'],
        approval_policy: {
          requires_explicit_acceptance: true,
          requires_local_validation: true,
          requires_policy_check: true,
        },
        visibility: 'tenant',
        advertised_at: '2026-06-24T00:02:00.000Z',
      }),
      ajv.errorsText(validateCapability.errors),
    ).toBe(true);

    expect(
      validateRequest({
        kind: 'mesh-request',
        request_id: 'meshreq-001',
        tenant_scope: {
          tenant_id: 'tenant-acme',
          scope: 'same_tenant',
        },
        sender_peer_id: 'peer-sender',
        created_at: '2026-06-24T00:03:00.000Z',
        ttl_ms: 60000,
        idempotency_key: 'idem-001',
        correlation_id: 'corr-001',
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
      }),
      ajv.errorsText(validateRequest.errors),
    ).toBe(true);

    expect(
      validateDelivery({
        kind: 'mesh-delivery-record',
        delivery_id: 'delivery-001',
        message_id: 'msg-001',
        request_id: 'meshreq-001',
        tenant_scope: {
          tenant_id: 'tenant-acme',
          scope: 'same_tenant',
        },
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
        attempt_count: 0,
        status: 'queued',
        route: {
          selector: {
            kind: 'peer',
            peer_id: 'peer-a1',
          },
          decision: 'direct',
          selected_peer_id: 'peer-a1',
          selected_at: '2026-06-24T00:03:01.000Z',
          policy_version: '1.0.0',
        },
        created_at: '2026-06-24T00:03:00.000Z',
      }),
      ajv.errorsText(validateDelivery.errors),
    ).toBe(true);

    expect(
      validateSubscription({
        kind: 'mesh-topic-subscription',
        subscription_id: 'sub-001',
        tenant_id: 'tenant-acme',
        topic: 'release.review',
        peer_id: 'peer-a1',
        filters: {
          request_kinds: ['notification.publish'],
          payload_classifications: ['public'],
        },
        expires_at: '2026-06-24T01:03:00.000Z',
        policy_version: '1.0.0',
      }),
      ajv.errorsText(validateSubscription.errors),
    ).toBe(true);
  });

  it('rejects personal payloads and unknown selectors', () => {
    const ajv = makeAjv();
    const requestSchema = loadJson('knowledge/product/schemas/mesh-request.schema.json');
    const validateRequest = ajv.compile(requestSchema);

    expect(
      validateRequest({
        kind: 'mesh-request',
        request_id: 'meshreq-002',
        tenant_scope: {
          tenant_id: 'tenant-acme',
          scope: 'same_tenant',
        },
        sender_peer_id: 'peer-sender',
        created_at: '2026-06-24T00:03:00.000Z',
        ttl_ms: 60000,
        idempotency_key: 'idem-002',
        correlation_id: 'corr-002',
        request_kind: 'review.request',
        target: {
          selector: {
            kind: 'broadcast',
            topic: 'release.review',
          },
        },
        payload: {
          classification: 'personal',
          reference: {
            artifact_ref: 'artifact://tenant-acme/private-note',
            integrity_hash: 'sha256:fedcba9876543210',
            storage_class: 'artifact_store',
          },
        },
      }),
    ).toBe(false);
  });

  it('keeps the mesh hub policy closed and aligned with the allowlist', () => {
    const policy = loadJson('knowledge/product/governance/mesh-hub-policy.json');
    expect(Object.keys(policy).sort()).toEqual([
      'data_tier',
      'placement',
      'recipient_acceptance',
      'routing',
      'tenant_scope',
      'topic_delivery',
      'version',
    ]);
    expect(policy.tenant_scope).toEqual({
      same_tenant_only: true,
      runtime_presence_required: true,
      catalog_is_bootstrap_only: true,
      catalog_cannot_override_runtime_revocation: true,
    });
    expect(policy.routing.selectors).toEqual(['peer', 'role', 'capability', 'topic']);
    expect(policy.routing.request_kinds).toEqual([
      'review.request',
      'workitem.claim',
      'workitem.handoff',
      'workitem.status_update',
      'capability.query',
      'notification.publish',
    ]);
    expect(policy.routing.automatic_peer_selection).toBe('deny');
    expect(policy.data_tier.personal).toBe('deny');
    expect(policy.data_tier.confidential.delivery_scope).toBe('same_tenant_only');
    expect(policy.topic_delivery.publisher_authorization).toBe('explicit');
    expect(policy.topic_delivery.subscriber_authorization).toBe('explicit_subscription');
    expect(policy.topic_delivery.max_fan_out).toBeGreaterThan(0);
    expect(policy.recipient_acceptance['review.request']).toBe('required');
    expect(policy.recipient_acceptance['workitem.handoff']).toBe('required');
    expect(policy.recipient_acceptance.side_effects).toBe('required');
    expect(policy.recipient_acceptance.mission_lifecycle).toBe('deny');
  });
});
