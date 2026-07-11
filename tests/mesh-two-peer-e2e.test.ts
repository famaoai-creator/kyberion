import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import {
  clearMeshMessageBrokerNamespace,
  clearPeerRuntime,
  createMeshMessageBroker,
  createPeerMessagingServer,
  listPeerInboxRecords,
  runMeshDeliveryPass,
  type MeshRequest,
} from '@agent/core';

/**
 * AA-02 acceptance: two-peer end-to-end. Peer A's broker enqueues a direct
 * delivery; the real delivery driver dispatches it through the real
 * HTTP+HMAC adapter to peer B's live PeerMessagingServer; the ledger acks;
 * peer B's inbox holds the request; re-accepting the same idempotency key
 * is reported as a duplicate (at-least-once dedup).
 */

const SHARED_SECRET = 'e2e-shared-secret';
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PEER_A = `peer-a-e2e-${RUN}`;
const PEER_B = `peer-b-e2e-${RUN}`;
const NAMESPACE = `e2e-${RUN}`;

function buildRequest(requestId: string): MeshRequest {
  return {
    kind: 'mesh-request',
    request_id: requestId,
    tenant_scope: { tenant_id: 'e2e-demo' },
    sender_peer_id: PEER_A,
    created_at: new Date().toISOString(),
    ttl_ms: 30 * 60_000,
    idempotency_key: `idem-${requestId}`,
    correlation_id: requestId,
    request_kind: 'workitem.handoff',
    target: { selector: { kind: 'peer', peer_id: PEER_B } },
    payload: {
      classification: 'public',
      reference: {
        artifact_ref: `artifact:e2e-${requestId}`,
        integrity_hash: 'sha256:e2e',
        storage_class: 'artifact_store',
      },
    },
  } as MeshRequest;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
  clearMeshMessageBrokerNamespace(NAMESPACE);
  clearPeerRuntime(PEER_A);
  clearPeerRuntime(PEER_B);
});

describe('mesh two-peer E2E (AA-02)', () => {
  it('delivers over real HTTP+HMAC, acks the ledger, and dedups the idempotency key', async () => {
    // Peer B: a live receiving server on an ephemeral port.
    const receiver = createPeerMessagingServer({
      peerId: PEER_B,
      sharedSecret: SHARED_SECRET,
    });
    const server = await receiver.listen(0);
    cleanups.push(() => receiver.close());
    const port = (server.address() as AddressInfo).port;

    // Peer A: a namespaced broker accepts the request and routes it direct.
    const broker = createMeshMessageBroker({ namespace: NAMESPACE });
    cleanups.push(() => broker.close());
    const request = buildRequest(`REQ-${RUN}`);
    // acceptMeshRequest routes peer selectors direct and persists the delivery.
    const accepted = await broker.acceptMeshRequest(request);
    expect(accepted.accepted).toBe(true);
    expect(accepted.duplicate).toBeFalsy();
    expect(accepted.delivery.route.decision).toBe('direct');

    // The real driver + real adapter deliver to the live server.
    const report = await runMeshDeliveryPass({
      senderPeerId: PEER_A,
      sharedSecret: SHARED_SECRET,
      writerLockId: `mesh-delivery-writer-e2e-${RUN}`,
      broker,
      resolvePeer: (peerId) =>
        peerId === PEER_B
          ? {
              peer_id: PEER_B,
              base_url: `http://127.0.0.1:${port}`,
              shared_secret: SHARED_SECRET,
            }
          : null,
    });

    expect(report.skipped).toBeUndefined();
    expect(report.delivered).toBe(1);
    expect(report.failures).toEqual([]);

    // Receiver side: the request landed in peer B's inbox.
    const inbox = listPeerInboxRecords(PEER_B);
    expect(inbox.length).toBeGreaterThanOrEqual(1);
    const payloads = JSON.stringify(inbox);
    expect(payloads).toContain(request.request_id);

    // At-least-once dedup: re-accepting the same idempotency key is a duplicate.
    const again = await broker.acceptMeshRequest(buildRequest(`REQ-${RUN}`));
    expect(again.duplicate).toBe(true);

    // A second pass finds nothing left to deliver.
    const second = await runMeshDeliveryPass({
      senderPeerId: PEER_A,
      sharedSecret: SHARED_SECRET,
      writerLockId: `mesh-delivery-writer-e2e-${RUN}-2`,
      broker,
      resolvePeer: () => null,
    });
    expect(second.claimed).toBe(0);
  });

  it('redelivers after the receiver comes back up (acceptance 2b)', async () => {
    const broker = createMeshMessageBroker({ namespace: NAMESPACE });
    cleanups.push(() => broker.close());
    const request = buildRequest(`REQ-DOWN-${RUN}`);
    await broker.acceptMeshRequest(request);

    // Receiver down: grab an ephemeral port, then free it.
    const probe = createPeerMessagingServer({ peerId: PEER_B, sharedSecret: SHARED_SECRET });
    const probeServer = await probe.listen(0);
    const port = (probeServer.address() as AddressInfo).port;
    await probe.close();

    const peerRecord = {
      peer_id: PEER_B,
      base_url: `http://127.0.0.1:${port}`,
      shared_secret: SHARED_SECRET,
    };
    const retryPolicy = { initial_delay_ms: 10, max_delay_ms: 20, max_attempts: 5 };

    const downPass = await runMeshDeliveryPass({
      senderPeerId: PEER_A,
      sharedSecret: SHARED_SECRET,
      writerLockId: `mesh-delivery-writer-e2e-${RUN}-down`,
      broker,
      retryPolicy,
      dispatchTimeoutMs: 500,
      resolvePeer: () => peerRecord,
    });
    expect(downPass.delivered).toBe(0);
    expect(downPass.retried).toBe(1);

    // Receiver back up on the same port.
    const receiver = createPeerMessagingServer({ peerId: PEER_B, sharedSecret: SHARED_SECRET });
    await receiver.listen(port);
    cleanups.push(() => receiver.close());

    // Past the retry backoff (ms-scale) but well inside the request TTL.
    const futureNow = new Date(Date.now() + 5_000).toISOString();
    const upPass = await runMeshDeliveryPass({
      senderPeerId: PEER_A,
      sharedSecret: SHARED_SECRET,
      writerLockId: `mesh-delivery-writer-e2e-${RUN}-up`,
      broker,
      retryPolicy,
      now: futureNow,
      resolvePeer: () => peerRecord,
    });
    expect(upPass.delivered).toBe(1);
  });

  it('dead-letters after exhausting retries (acceptance 2c)', async () => {
    const broker = createMeshMessageBroker({ namespace: NAMESPACE });
    cleanups.push(() => broker.close());
    const request = buildRequest(`REQ-DEAD-${RUN}`);
    await broker.acceptMeshRequest(request);

    const retryPolicy = { initial_delay_ms: 1, max_delay_ms: 2, max_attempts: 3 };
    const deadPeer = {
      peer_id: PEER_B,
      base_url: 'http://127.0.0.1:1', // nothing ever listens here
      shared_secret: SHARED_SECRET,
    };

    let deadLettered = 0;
    for (let attempt = 0; attempt < 5 && deadLettered === 0; attempt += 1) {
      const pass = await runMeshDeliveryPass({
        senderPeerId: PEER_A,
        sharedSecret: SHARED_SECRET,
        writerLockId: `mesh-delivery-writer-e2e-${RUN}-dead-${attempt}`,
        broker,
        retryPolicy,
        now: new Date(Date.now() + (attempt + 1) * 1_000).toISOString(),
        dispatchTimeoutMs: 300,
        resolvePeer: () => deadPeer,
      });
      deadLettered += pass.dead_lettered;
    }

    expect(deadLettered).toBe(1);
    const deadLetters = await broker.listMeshDeadLetters({ request_id: request.request_id });
    expect(deadLetters.length).toBe(1);
  });
});
