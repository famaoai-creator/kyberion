import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildPeerMessageEnvelope,
  clearPeerRuntime,
  createPeerMessagingServer,
  loadPeerNetworkCatalog,
  listPeerInboxRecords,
  listPeerOutboxRecords,
  resolvePeerRecord,
  resolvePeerDispatchTarget,
  sendPeerMessage,
  verifyPeerMessage,
} from './peer-messaging.js';
import { safeRmSync, safeWriteFile } from './secure-io.js';
import { pathResolver } from './path-resolver.js';

const SHARED_SECRET = 'peer-message-test-secret';

afterEach(() => {
  clearPeerRuntime('peer-a-test');
  clearPeerRuntime('peer-b-test');
  const catalogPath = pathResolver.sharedTmp('peer-network-catalog.test.json');
  try {
    safeRmSync(catalogPath, { force: true });
  } catch (_) {}
});

describe('peer messaging', () => {
  it('builds and verifies signed peer envelopes', () => {
    const envelope = buildPeerMessageEnvelope({
      senderPeerId: 'peer-a-test',
      recipientPeerId: 'peer-b-test',
      subject: 'handoff',
      type: 'handoff',
      payload: { summary: 'transfer this task' },
      sharedSecret: SHARED_SECRET,
    });

    expect(envelope.signature).toBeTruthy();
    expect(verifyPeerMessage(envelope, SHARED_SECRET)).toBe(true);
    expect(verifyPeerMessage({ ...envelope, payload: { summary: 'tampered' } }, SHARED_SECRET)).toBe(false);
  });

  it('delivers a localhost peer message and persists inbox/outbox logs', async () => {
    const server = createPeerMessagingServer({
      peerId: 'peer-b-test',
      sharedSecret: SHARED_SECRET,
      responder: async ({ envelope }) => ({
        received: true,
        peer_id: 'peer-b-test',
        reply_to: envelope.message_id,
        subject: envelope.subject,
      }),
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input: any, init?: RequestInit) => {
      const envelope = JSON.parse(String(init?.body || '{}')) as Parameters<typeof server.processEnvelope>[0];
      const result = await server.processEnvelope(envelope);
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
        },
      });
    });

    const envelope = buildPeerMessageEnvelope({
      senderPeerId: 'peer-a-test',
      recipientPeerId: 'peer-b-test',
      subject: 'status_request',
      type: 'request',
      payload: { ask: 'are you there?' },
      sharedSecret: SHARED_SECRET,
      conversationId: 'conv-peer-test',
    });

    const receipt = await sendPeerMessage(envelope, {
      destinationUrl: 'http://127.0.0.1:4555',
      allowLocalNetwork: true,
      timeoutMs: 5000,
    });

    expect(receipt.ok).toBe(true);
    expect(receipt.status).toBe(200);
    expect(receipt.accepted).toBe(true);
    expect(receipt.processing_mode).toBe('synchronous_on_receive');
    expect(receipt.processed_at).toBeTruthy();
    expect(receipt.response).toMatchObject({
      received: true,
      peer_id: 'peer-b-test',
      reply_to: envelope.message_id,
    });

    const inbox = listPeerInboxRecords('peer-b-test');
    const outbox = listPeerOutboxRecords('peer-a-test');
    expect(inbox).toHaveLength(1);
    expect(outbox).toHaveLength(1);
    expect((inbox[0] as any).envelope.message_id).toBe(envelope.message_id);
    expect((outbox[0] as any).envelope.recipient_peer_id).toBe('peer-b-test');
    fetchSpy.mockRestore();
  });

  it('resolves peer catalog entries that point at LAN endpoints', () => {
    const catalogPath = pathResolver.sharedTmp('peer-network-catalog.test.json');
    safeWriteFile(catalogPath, JSON.stringify({
      version: '1',
      peers: [
        {
          peer_id: 'peer-b-test',
          base_url: 'http://192.168.1.20:4555',
          shared_secret: SHARED_SECRET,
          allow_local_network: true,
          capabilities: ['handoff', 'request'],
        },
      ],
    }, null, 2));

    const catalog = loadPeerNetworkCatalog({ catalogPath });
    expect(catalog).not.toBeNull();
    const peer = resolvePeerRecord('peer-b-test', catalog);
    expect(peer).toMatchObject({
      peer_id: 'peer-b-test',
      base_url: 'http://192.168.1.20:4555',
      allow_local_network: true,
    });

    const target = resolvePeerDispatchTarget('peer-b-test', catalog);
    expect(target.destinationUrl).toBe('http://192.168.1.20:4555');
    expect(target.allowLocalNetwork).toBe(true);
    expect(target.sharedSecret).toBe(SHARED_SECRET);
  });
});
