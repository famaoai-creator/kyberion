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
} from './work-coordination-peer.js';

const SHARED_SECRET = 'work-coordination-peer-secret';

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
      sharedSecret: SHARED_SECRET,
      responder: createWorkCoordinationPeerResponder(),
    });

    const claimEnvelope = buildWorkCoordinationPeerCommandEnvelope({
      senderPeerId: 'peer-a',
      recipientPeerId: 'peer-a',
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
    expect(getWorkItem(item.item_id)?.lease_id).toBe((claimResult.body as any).response.result.lease.lease_id);

    const updateEnvelope = buildWorkCoordinationPeerCommandEnvelope({
      senderPeerId: 'peer-a',
      recipientPeerId: 'peer-a',
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
      sharedSecret: SHARED_SECRET,
      responder: createWorkCoordinationPeerResponder(),
    });

    const untrustedEnvelope = buildWorkCoordinationPeerCommandEnvelope({
      senderPeerId: 'untrusted-peer',
      recipientPeerId: 'peer-a',
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

    await expect(server.processEnvelope(untrustedEnvelope)).rejects.toThrow('untrusted_peer:untrusted-peer');
  });
});
