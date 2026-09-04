import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createPeerMessagingServer } from './peer-messaging.js';
import {
  clearWorkCoordinationStore,
  clearWorkCoordinationNamespace,
  createWorkItem,
  getWorkItem,
  setWorkCoordinationNamespace,
} from './work-coordination.js';
import {
  buildWorkCoordinationPeerCommandEnvelope,
  createWorkCoordinationPeerResponder,
  processWorkCoordinationPeerCommand,
} from './work-coordination-peer.js';

const SHARED_SECRET = 'work-coordination-peer-secret';
const TENANT_ID = 'tenant-acme';

beforeEach(() => {
  setWorkCoordinationNamespace('work-coordination-peer-test');
  clearWorkCoordinationStore();
});

afterEach(() => {
  clearWorkCoordinationStore();
  clearWorkCoordinationNamespace();
});

describe('work coordination peer bridge', () => {
  it('claims and updates items through peer messaging responder', async () => {
    const item = createWorkItem({
      title: 'Peer bridge item',
      description: 'Use peer transport to claim and update work',
      projectId: 'PRJ-PEER',
    });

    const server = createPeerMessagingServer({
      peerId: 'peer-a',
      tenantId: TENANT_ID,
      sharedSecret: SHARED_SECRET,
      responder: createWorkCoordinationPeerResponder(),
    });

    const claimEnvelope = buildWorkCoordinationPeerCommandEnvelope({
      senderPeerId: 'peer-a',
      recipientPeerId: 'peer-a',
      tenantId: TENANT_ID,
      sharedSecret: SHARED_SECRET,
      command: {
        command_type: 'claim_request',
        command_id: 'cmd-claim-1',
        item_id: item.item_id,
        actor_peer_id: 'peer-a',
        purpose: 'implementation',
        expected_version: 1,
        idempotency_key: 'idem-claim-1',
      },
    });

    const claimResult = await server.processEnvelope(claimEnvelope);
    expect(claimResult.status).toBe(200);
    expect(claimResult.body).toMatchObject({
      ok: true,
      accepted: true,
    });
    const claimed = (claimResult.body as any).response.result.item;
    expect(claimed.status).toBe('in_progress');
    expect(getWorkItem(item.item_id)?.lease_id).toBe(
      (claimResult.body as any).response.result.lease.lease_id
    );

    const updateEnvelope = buildWorkCoordinationPeerCommandEnvelope({
      senderPeerId: 'peer-a',
      recipientPeerId: 'peer-a',
      tenantId: TENANT_ID,
      sharedSecret: SHARED_SECRET,
      command: {
        command_type: 'status_update',
        command_id: 'cmd-update-1',
        item_id: item.item_id,
        next_status: 'review',
        expected_version: claimed.version,
        payload: { reviewer: 'team-1' },
      },
    });

    const updateResult = await server.processEnvelope(updateEnvelope);
    expect(updateResult.status).toBe(200);
    expect((updateResult.body as any).response.result.item.status).toBe('review');
  });

  it('rejects commands from untrusted peers not in the whitelist', async () => {
    const item = createWorkItem({
      title: 'Untrusted peer item',
      description: 'Verify rejection of untrusted peers',
      projectId: 'PRJ-UNTRUSTED',
    });

    const server = createPeerMessagingServer({
      peerId: 'peer-a',
      tenantId: TENANT_ID,
      sharedSecret: SHARED_SECRET,
      responder: createWorkCoordinationPeerResponder(),
    });

    const untrustedEnvelope = buildWorkCoordinationPeerCommandEnvelope({
      senderPeerId: 'untrusted-peer',
      recipientPeerId: 'peer-a',
      tenantId: TENANT_ID,
      sharedSecret: SHARED_SECRET,
      command: {
        command_type: 'claim_request',
        command_id: 'cmd-claim-untrusted',
        item_id: item.item_id,
        actor_peer_id: 'untrusted-peer',
        purpose: 'implementation',
        expected_version: 1,
        idempotency_key: 'idem-claim-untrusted',
      },
    });

    const response = await server.processEnvelope(untrustedEnvelope);
    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      ok: false,
      error_code: 'internal',
    });
  });

  it('rejects malformed command payloads before work mutation', async () => {
    const item = createWorkItem({
      title: 'Malformed peer item',
      description: 'Verify command payload validation',
      projectId: 'PRJ-MALFORMED',
    });
    const envelope = buildWorkCoordinationPeerCommandEnvelope({
      senderPeerId: 'peer-a',
      recipientPeerId: 'peer-a',
      tenantId: TENANT_ID,
      sharedSecret: SHARED_SECRET,
      command: {
        command_type: 'status_update',
        command_id: 'cmd-invalid-status',
        item_id: item.item_id,
        next_status: 'ready',
      },
    });
    envelope.payload = {
      command_type: 'status_update',
      command_id: envelope.payload.command_id,
      item_id: item.item_id,
      next_status: 'not-a-work-item-status',
      payload: { ttlMs: 'invalid' },
      unknown_field: 'drop',
    } as unknown as typeof envelope.payload;

    await expect(
      processWorkCoordinationPeerCommand({ peerId: 'peer-a', envelope })
    ).rejects.toThrow('invalid_coordination_next_status');
    expect(getWorkItem(item.item_id)?.status).toBe('backlog');
  });

  it('rejects invalid claim ttl before claiming an item', async () => {
    const item = createWorkItem({
      title: 'Invalid ttl peer item',
      description: 'Verify ttl validation',
      projectId: 'PRJ-INVALID-TTL',
    });
    const envelope = buildWorkCoordinationPeerCommandEnvelope({
      senderPeerId: 'peer-a',
      recipientPeerId: 'peer-a',
      tenantId: TENANT_ID,
      sharedSecret: SHARED_SECRET,
      command: {
        command_type: 'claim_request',
        command_id: 'cmd-invalid-ttl',
        item_id: item.item_id,
        payload: { ttlMs: 1000 },
      },
    });
    envelope.payload = {
      ...envelope.payload,
      payload: { ttlMs: -1 },
    };

    await expect(
      processWorkCoordinationPeerCommand({ peerId: 'peer-a', envelope })
    ).rejects.toThrow('invalid_coordination_ttl');
    expect(getWorkItem(item.item_id)?.status).toBe('backlog');
  });
});
