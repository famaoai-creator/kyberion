import { afterEach, describe, expect, it } from 'vitest';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import {
  clearMeshMessageBrokerNamespace,
  createMeshMessageBroker,
  MeshHubCommandLoop,
} from './mesh-message-broker.js';
import type { MeshRequest } from './mesh-hub-contract.js';

function namespacePath(namespace: string, segment: string): string {
  return `active/shared/runtime/mesh-hub/${namespace}/${segment}`;
}

function observabilityPath(namespace: string): string {
  return `active/shared/observability/mesh-hub/${namespace}/events.jsonl`;
}

function readJsonl(path: string): any[] {
  if (!safeExistsSync(path)) return [];
  const raw = String(safeReadFile(path, { encoding: 'utf8' }) || '');
  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function buildRequest(input: {
  requestId: string;
  idempotencyKey: string;
  createdAt: string;
  ttlMs: number;
  body?: string;
}): MeshRequest {
  const payload: any = {
    classification: 'confidential',
    reference: {
      artifact_ref: 'artifact://tenant-acme/review-brief',
      integrity_hash: 'sha256:0123456789abcdef',
      storage_class: 'artifact_store',
    },
  };
  if (input.body) payload.body = input.body;
  return {
    kind: 'mesh-request',
    request_id: input.requestId,
    tenant_scope: {
      tenant_id: 'tenant-acme',
      scope: 'same_tenant',
    },
    sender_peer_id: 'peer-sender',
    created_at: input.createdAt,
    ttl_ms: input.ttlMs,
    idempotency_key: input.idempotencyKey,
    correlation_id: `corr-${input.requestId}`,
    request_kind: 'review.request',
    target: {
      selector: {
        kind: 'peer',
        peer_id: 'peer-recipient',
      },
    },
    payload,
  };
}

describe('mesh-message-broker', () => {
  let activeBroker: { close: () => void } | null = null;

  afterEach(() => {
    activeBroker?.close();
    activeBroker = null;
    clearMeshMessageBrokerNamespace('mesh-message-broker-test');
    clearMeshMessageBrokerNamespace('mesh-message-broker-expiry-test');
    clearMeshMessageBrokerNamespace('mesh-message-broker-fence-test');
    clearMeshMessageBrokerNamespace('mesh-message-broker-ack-test');
  });

  it('serializes duplicate accepts, persists one delivery id, and redacts raw payload content', async () => {
    const namespace = 'mesh-message-broker-test';
    const broker = createMeshMessageBroker({ namespace });
    activeBroker = broker;
    const requestTime = new Date().toISOString();
    const request = buildRequest({
      requestId: 'meshreq-001',
      idempotencyKey: 'idem-001',
      createdAt: requestTime,
      ttlMs: 60_000,
      body: 'RAW_SECRET_PAYLOAD',
    });

    const [first, second] = await Promise.all([
      broker.acceptMeshRequest(request, { now: requestTime }),
      broker.acceptMeshRequest(request, { now: requestTime }),
    ]);

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    expect(first.delivery.delivery_id).toBe(second.delivery.delivery_id);
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(first.delivery.status).toBe('queued');

    const deliveries = readJsonl(namespacePath(namespace, 'deliveries.jsonl'));
    const events = readJsonl(observabilityPath(namespace));
    expect(deliveries).toHaveLength(2);
    expect(new Set(deliveries.map((row) => row.delivery_id)).size).toBe(1);
    expect(deliveries.map((row) => row.status)).toEqual(['accepted', 'queued']);
    expect(JSON.stringify(deliveries)).not.toContain('RAW_SECRET_PAYLOAD');
    expect(JSON.stringify(events)).not.toContain('RAW_SECRET_PAYLOAD');
    expect(deliveries[0].payload).toEqual({
      classification: 'confidential',
      reference: {
        artifact_ref: 'artifact://tenant-acme/review-brief',
        integrity_hash: 'sha256:0123456789abcdef',
        storage_class: 'artifact_store',
      },
    });

  });

  it('fences a second writer and rejects reentrant commands deterministically', async () => {
    const namespace = 'mesh-message-broker-fence-test';
    const loop = new MeshHubCommandLoop(namespace);
    activeBroker = loop;

    expect(() => new MeshHubCommandLoop(namespace)).toThrow(/mesh_hub_writer_fenced/);
    await expect(
      loop.run('outer', async () =>
        loop.run('inner', async () => 1),
      ),
    ).rejects.toThrow(/mesh_hub_reentrant_command_rejected/);
  });

  it('acks, rejects, expires, and refuses stale retry or re-accept paths', async () => {
    const namespace = 'mesh-message-broker-expiry-test';
    const broker = createMeshMessageBroker({ namespace });
    activeBroker = broker;
    const requestTime = new Date().toISOString();
    const request = buildRequest({
      requestId: 'meshreq-002',
      idempotencyKey: 'idem-002',
      createdAt: requestTime,
      ttlMs: 1_000,
    });

    const accepted = await broker.acceptMeshRequest(request, { now: requestTime });
    const claimed = await broker.claimDueMeshDeliveries(requestTime, 1);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].status).toBe('dispatched');

    const acked = await broker.acknowledgeMeshDelivery(claimed[0].delivery_id);
    expect(acked.status).toBe('acknowledged');

    const rejectedRequest = buildRequest({
      requestId: 'meshreq-003',
      idempotencyKey: 'idem-003',
      createdAt: requestTime,
      ttlMs: 1_000,
      body: 'SECOND_RAW_SECRET',
    });
    await broker.acceptMeshRequest(rejectedRequest, { now: requestTime });
    const rejectedClaim = await broker.claimDueMeshDeliveries(requestTime, 1);
    const rejected = await broker.rejectMeshDelivery(rejectedClaim[0].delivery_id, {
      code: 'recipient_rejected',
      redacted_reason: 'recipient rejected with redacted reason',
      failure_class: 'recipient_rejected',
    });
    expect(rejected.status).toBe('rejected');

    const expiredRequest = buildRequest({
      requestId: 'meshreq-004',
      idempotencyKey: 'idem-004',
      createdAt: requestTime,
      ttlMs: 1_000,
    });
    const expiredAccepted = await broker.acceptMeshRequest(expiredRequest, { now: requestTime });
    const expiredAt = new Date(Date.parse(requestTime) + 2_000).toISOString();
    const expired = await broker.expireMeshDeliveries(expiredAt);
    expect(expired.some((row) => row.delivery_id === expiredAccepted.delivery.delivery_id)).toBe(true);
    const retried = await broker.retryMeshDelivery(expiredAccepted.delivery.delivery_id, expiredAt);
    expect(retried.status).toBe('expired');
    await expect(
      broker.acceptMeshRequest(expiredRequest, { now: expiredAt }),
    ).resolves.toMatchObject({
      duplicate: true,
    });

    const brokerDeadLetters = await broker.listMeshDeadLetters({ tenant_id: 'tenant-acme' });
    expect(brokerDeadLetters.some((row) => row.redacted_reason.includes('payload'))).toBe(false);
    expect(JSON.stringify(brokerDeadLetters)).not.toContain('RAW_SECRET_PAYLOAD');
    expect(JSON.stringify(brokerDeadLetters)).not.toContain('SECOND_RAW_SECRET');

    const runtimeRecords = readJsonl(namespacePath(namespace, 'deliveries.jsonl'));
    expect(runtimeRecords.every((row) => !JSON.stringify(row).includes('RAW_SECRET_PAYLOAD'))).toBe(true);
    expect(runtimeRecords.every((row) => !JSON.stringify(row).includes('SECOND_RAW_SECRET'))).toBe(true);
  });
});
