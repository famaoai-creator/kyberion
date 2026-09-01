import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPeerMessagingServer } from './peer-messaging.js';
import { pathResolver } from './path-resolver.js';
import { safeRmSync, safeWriteFile } from './secure-io.js';
import {
  appendPeerConversationTranscript,
  buildPeerConversationEnvelope,
  clearPeerConversationRuntime,
  createPeerConversationResponder,
  createPeerConversationSession,
  listPeerConversationSessions,
  loadPeerConversationSession,
  parsePeerConversationTranscriptEntry,
  sendPeerConversationMessageToPeer,
} from './peer-conversation.js';

const SHARED_SECRET = 'peer-conversation-test-secret';
const TENANT_ID = 'tenant-acme';
const CATALOG_PATH = pathResolver.sharedTmp('peer-conversation-catalog.test.json');

afterEach(() => {
  clearPeerConversationRuntime(TENANT_ID, 'peer-a-test');
  clearPeerConversationRuntime(TENANT_ID, 'peer-b-test');
  try {
    safeRmSync(CATALOG_PATH, { force: true });
  } catch (_) {
    /* best-effort cleanup */
  }
});

describe('peer conversation', () => {
  it('validates transcript entries before peer response projection', () => {
    expect(
      parsePeerConversationTranscriptEntry({
        message_id: 'PCM-1',
        kind: 'reply',
        direction: 'inbound',
        sender_peer_id: 'peer-b-test',
        recipient_peer_id: 'peer-a-test',
        text: 'ack',
        created_at: new Date().toISOString(),
      })
    ).toMatchObject({ kind: 'reply', sender_peer_id: 'peer-b-test' });
    expect(() => parsePeerConversationTranscriptEntry(null)).toThrow(
      'invalid_peer_conversation_transcript_entry'
    );
    expect(() =>
      parsePeerConversationTranscriptEntry({
        message_id: 'PCM-1',
        kind: 'reply',
        direction: 'inbound',
        sender_peer_id: 'peer-b-test',
        recipient_peer_id: 'peer-a-test',
        text: 'ack',
        created_at: new Date().toISOString(),
        related_work_item_ids: [42],
      })
    ).toThrow('invalid_peer_conversation_transcript_related_work_item_ids');
  });

  it('rejects traversal-shaped tenant, peer, and session identifiers before storage access', () => {
    expect(() =>
      createPeerConversationSession({
        localPeerId: 'peer-a-test',
        remotePeerId: 'peer-b-test',
        tenantId: TENANT_ID,
        sessionId: '../../outside',
        topic: 'invalid-session',
      })
    ).toThrow('invalid_peer_conversation_session_id');
    expect(() => loadPeerConversationSession(TENANT_ID, '../outside', 'PCS-test')).toThrow(
      'invalid_peer_conversation_peer_id'
    );
    expect(() => clearPeerConversationRuntime('../outside', 'peer-a-test')).toThrow(
      'invalid_peer_conversation_tenant_id'
    );
  });

  it('creates and persists a conversation session with transcript entries', () => {
    const session = createPeerConversationSession({
      localPeerId: 'peer-a-test',
      remotePeerId: 'peer-b-test',
      tenantId: TENANT_ID,
      topic: 'kanban-sync',
      relatedWorkItemIds: ['WIT-1'],
    });

    const saved = appendPeerConversationTranscript({
      sessionId: session.session_id,
      tenantId: TENANT_ID,
      localPeerId: 'peer-a-test',
      remotePeerId: 'peer-b-test',
      kind: 'open',
      direction: 'outbound',
      text: 'Open a lane for WIT-1',
      relatedWorkItemIds: ['WIT-1'],
    });

    expect(saved.related_work_item_ids).toContain('WIT-1');
    const loaded = loadPeerConversationSession(TENANT_ID, 'peer-a-test', session.session_id);
    expect(loaded?.transcript).toHaveLength(1);
  });

  it('builds a peer conversation envelope with conversation metadata', () => {
    const envelope = buildPeerConversationEnvelope({
      senderPeerId: 'peer-a-test',
      recipientPeerId: 'peer-b-test',
      tenantId: TENANT_ID,
      sharedSecret: SHARED_SECRET,
      sessionId: 'PCS-test',
      topic: 'kanban-sync',
      text: 'Hello',
      relatedWorkItemIds: ['WIT-1'],
    });

    expect(envelope.subject).toBe('conversation.message');
    expect(envelope.conversation_id).toBe('PCS-test');
    expect((envelope.payload as any).kind).toBe('peer_conversation_message');
  });

  it('sends and receives a local-network conversation through peer messaging', async () => {
    safeWriteFile(
      CATALOG_PATH,
      JSON.stringify(
        {
          version: '1',
          tenant_id: TENANT_ID,
          peers: [
            {
              peer_id: 'peer-b-test',
              base_url: 'http://127.0.0.1:4555',
              shared_secret: SHARED_SECRET,
              allow_local_network: true,
              capabilities: ['conversation'],
            },
          ],
        },
        null,
        2
      )
    );

    const server = createPeerMessagingServer({
      peerId: 'peer-b-test',
      tenantId: TENANT_ID,
      sharedSecret: SHARED_SECRET,
      responder: createPeerConversationResponder({ peerId: 'peer-b-test', tenantId: TENANT_ID }),
    });

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (_input: any, init?: RequestInit) => {
        const envelope = JSON.parse(String(init?.body || '{}')) as Parameters<
          typeof server.processEnvelope
        >[0];
        const result = await server.processEnvelope(envelope);
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      });

    const outcome = await sendPeerConversationMessageToPeer({
      senderPeerId: 'peer-a-test',
      recipientPeerId: 'peer-b-test',
      tenantId: TENANT_ID,
      topic: 'kanban-sync',
      text: 'Can you review WIT-1?',
      relatedWorkItemIds: ['WIT-1'],
      catalogPath: CATALOG_PATH,
      timeoutMs: 5000,
    });

    expect(outcome.receipt.ok).toBe(true);
    expect(outcome.receipt.accepted).toBe(true);
    expect(outcome.receipt.processing_mode).toBe('synchronous_on_receive');
    expect(outcome.receipt.response).toMatchObject({
      session: expect.any(Object),
      reply: expect.any(Object),
    });

    const senderSession = listPeerConversationSessions(TENANT_ID, 'peer-a-test')[0];
    const receiverSession = listPeerConversationSessions(TENANT_ID, 'peer-b-test')[0];
    expect(senderSession.transcript).toHaveLength(2);
    expect(receiverSession.transcript).toHaveLength(2);
    expect(senderSession.related_work_item_ids).toContain('WIT-1');
    expect(receiverSession.related_work_item_ids).toContain('WIT-1');
    fetchSpy.mockRestore();
  });
});
