import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  expireMeshDeliveries: vi.fn(),
  claimDueMeshDeliveries: vi.fn(),
  acknowledgeMeshDelivery: vi.fn(),
  retryMeshDelivery: vi.fn(),
}));

vi.mock('./mesh-message-broker.js', () => ({
  expireMeshDeliveries: mocks.expireMeshDeliveries,
  claimDueMeshDeliveries: mocks.claimDueMeshDeliveries,
  acknowledgeMeshDelivery: mocks.acknowledgeMeshDelivery,
  retryMeshDelivery: mocks.retryMeshDelivery,
}));

vi.mock('./core.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { runMeshDeliveryPass } from './mesh-delivery-driver.js';

function buildDelivery(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'mesh-delivery-record',
    delivery_id: 'DLV-1',
    message_id: 'MSG-1',
    request_id: 'REQ-1',
    tenant_scope: { tenant_id: 'demo' },
    request_kind: 'workitem.handoff',
    target: { selector: { kind: 'peer', peer_id: 'peer-b' } },
    payload: { classification: 'public', body: { note: 'hi' } },
    attempt_count: 1,
    status: 'dispatched',
    route: {
      selector: { kind: 'peer', peer_id: 'peer-b' },
      decision: 'direct',
      selected_peer_id: 'peer-b',
      policy_version: '1.0.0',
    },
    created_at: '2026-07-05T00:00:00.000Z',
    idempotency_key: 'IDEM-1',
    expires_at: '2026-07-05T01:00:00.000Z',
    ...overrides,
  };
}

const PEER_B = {
  peer_id: 'peer-b',
  base_url: 'http://127.0.0.1:9999/peer',
  shared_secret: 's3cret',
};

describe('runMeshDeliveryPass', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.expireMeshDeliveries.mockResolvedValue([]);
  });

  it('dispatches claimed deliveries and acknowledges successes', async () => {
    const delivery = buildDelivery();
    mocks.claimDueMeshDeliveries.mockResolvedValue([delivery]);
    mocks.acknowledgeMeshDelivery.mockResolvedValue({ ...delivery, status: 'acknowledged' });
    const dispatcher = { dispatchToPeer: vi.fn().mockResolvedValue({ ok: true }) };

    const report = await runMeshDeliveryPass({
      senderPeerId: 'peer-a',
      dispatcher,
      resolvePeer: () => PEER_B,
    });

    expect(report.delivered).toBe(1);
    expect(report.retried).toBe(0);
    const dispatchInput = dispatcher.dispatchToPeer.mock.calls[0][0];
    expect(dispatchInput.recipient).toEqual(PEER_B);
    // The reconstructed request keeps the persisted idempotency key so the
    // receiver's dedup survives redelivery.
    expect(dispatchInput.request.idempotency_key).toBe('IDEM-1');
    expect(dispatchInput.request.sender_peer_id).toBe('peer-a');
    expect(mocks.acknowledgeMeshDelivery).toHaveBeenCalledWith('DLV-1', {});
  });

  it('feeds transport failures back into the broker retry state machine', async () => {
    const delivery = buildDelivery();
    mocks.claimDueMeshDeliveries.mockResolvedValue([delivery]);
    mocks.retryMeshDelivery.mockResolvedValue({ ...delivery, status: 'queued', attempt_count: 2 });
    const dispatcher = { dispatchToPeer: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) };

    const report = await runMeshDeliveryPass({
      senderPeerId: 'peer-a',
      dispatcher,
      resolvePeer: () => PEER_B,
    });

    expect(report.delivered).toBe(0);
    expect(report.retried).toBe(1);
    expect(report.failures[0]).toMatchObject({ delivery_id: 'DLV-1' });
    expect(mocks.retryMeshDelivery).toHaveBeenCalledWith('DLV-1', expect.any(String), undefined);
  });

  it('counts dead-letter transitions reported by the broker', async () => {
    const delivery = buildDelivery();
    mocks.claimDueMeshDeliveries.mockResolvedValue([delivery]);
    mocks.retryMeshDelivery.mockResolvedValue({ ...delivery, status: 'dead_lettered' });
    const dispatcher = { dispatchToPeer: vi.fn().mockRejectedValue(new Error('boom')) };

    const report = await runMeshDeliveryPass({
      senderPeerId: 'peer-a',
      dispatcher,
      resolvePeer: () => PEER_B,
    });

    expect(report.dead_lettered).toBe(1);
    expect(report.retried).toBe(0);
  });

  it('routes unresolvable peers back to retry without dispatching', async () => {
    const delivery = buildDelivery();
    mocks.claimDueMeshDeliveries.mockResolvedValue([delivery]);
    mocks.retryMeshDelivery.mockResolvedValue({ ...delivery, status: 'queued' });
    const dispatcher = { dispatchToPeer: vi.fn() };

    const report = await runMeshDeliveryPass({
      senderPeerId: 'peer-a',
      dispatcher,
      resolvePeer: () => null,
    });

    expect(report.unroutable).toBe(1);
    expect(dispatcher.dispatchToPeer).not.toHaveBeenCalled();
    expect(mocks.retryMeshDelivery).toHaveBeenCalled();
  });

  it('never auto-selects a peer for operator-selection routes', async () => {
    const delivery = buildDelivery({
      route: {
        selector: { kind: 'topic', topic: 'ops' },
        decision: 'requires_operator_selection',
        policy_version: '1.0.0',
      },
    });
    mocks.claimDueMeshDeliveries.mockResolvedValue([delivery]);
    mocks.retryMeshDelivery.mockResolvedValue({ ...delivery, status: 'queued' });
    const dispatcher = { dispatchToPeer: vi.fn() };

    const report = await runMeshDeliveryPass({
      senderPeerId: 'peer-a',
      dispatcher,
      resolvePeer: () => PEER_B,
    });

    expect(dispatcher.dispatchToPeer).not.toHaveBeenCalled();
    expect(report.unroutable).toBe(1);
  });

  it('runs TTL expiry at the start of every pass', async () => {
    mocks.expireMeshDeliveries.mockResolvedValue([buildDelivery({ status: 'expired' })]);
    mocks.claimDueMeshDeliveries.mockResolvedValue([]);

    const report = await runMeshDeliveryPass({
      senderPeerId: 'peer-a',
      dispatcher: { dispatchToPeer: vi.fn() },
      resolvePeer: () => PEER_B,
    });

    expect(report.expired).toBe(1);
    expect(report.claimed).toBe(0);
  });
});
