import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearPeerRuntime,
  createPeerMessagingServer,
  peerNetworkCatalogPath,
  registerPeerNetworkPeer,
} from './peer-messaging.js';
import { pathResolver } from '../path-resolver.js';
import { withExecutionContext, withExecutionContextAsync } from '../authority.js';
import { safeAppendFile, safeReadFile, safeRmSync, safeWriteFile } from '../secure-io.js';
import {
  PEER_CATALOG_READER_ROLE,
  appendPeerConversationTranscript,
  buildPeerConversationEnvelope,
  clearPeerConversationRuntime,
  collectPeerTranscriptTails,
  createPeerConversationResponder,
  createPeerConversationSession,
  listPeerConversationPeers,
  listPeerConversationSessions,
  listPeerConversationTenants,
  loadPeerConversationSession,
  parsePeerConversationTranscriptEntry,
  readPeerConversationEdges,
  sendPeerConversationMessageToPeer,
} from './peer-conversation.js';

const SHARED_SECRET = 'peer-conversation-test-secret';
const TENANT_ID = 'tenant-acme';
const CATALOG_PATH = pathResolver.sharedTmp('peer-conversation-catalog.test.json');

afterEach(() => {
  clearPeerConversationRuntime(TENANT_ID, 'peer-a-test');
  clearPeerConversationRuntime(TENANT_ID, 'peer-b-test');
  // The receiving server dedups on message_handled events; drop them so an
  // explicit messageId is not seen as a duplicate on the next run.
  clearPeerRuntime(TENANT_ID, 'peer-a-test');
  clearPeerRuntime(TENANT_ID, 'peer-b-test');
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
      .mockImplementation(async (_input: unknown, init?: RequestInit) => {
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

  it('resends with an explicit messageId idempotently and keeps fresh ids otherwise', async () => {
    safeWriteFile(
      CATALOG_PATH,
      JSON.stringify({
        version: '1',
        tenant_id: TENANT_ID,
        peers: [
          {
            peer_id: 'peer-b-test',
            base_url: 'http://127.0.0.1:4555',
            shared_secret: SHARED_SECRET,
            allow_local_network: true,
          },
        ],
      })
    );
    const server = createPeerMessagingServer({
      peerId: 'peer-b-test',
      tenantId: TENANT_ID,
      sharedSecret: SHARED_SECRET,
      responder: createPeerConversationResponder({ peerId: 'peer-b-test', tenantId: TENANT_ID }),
    });
    const envelopeIds: string[] = [];
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (_input: unknown, init?: RequestInit) => {
        const envelope = JSON.parse(String(init?.body || '{}'));
        envelopeIds.push(envelope.message_id);
        const result = await server.processEnvelope(envelope);
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      });
    const send = (sessionId: string, messageId?: string) =>
      sendPeerConversationMessageToPeer({
        senderPeerId: 'peer-a-test',
        recipientPeerId: 'peer-b-test',
        tenantId: TENANT_ID,
        sessionId,
        topic: 'idempotent',
        text: 'same text',
        catalogPath: CATALOG_PATH,
        timeoutMs: 5000,
        ...(messageId ? { messageId } : {}),
      });

    const first = await send('PCS-IDEMPOTENT', 'PCM-STABLE-1');
    const second = await send('PCS-IDEMPOTENT', 'PCM-STABLE-1');
    expect(first.receipt.duplicate).toBeUndefined();
    expect(second.receipt).toMatchObject({ ok: true, duplicate: true });
    expect(envelopeIds).toEqual(['PCM-STABLE-1', 'PCM-STABLE-1']);
    const idempotent = loadPeerConversationSession(TENANT_ID, 'peer-a-test', 'PCS-IDEMPOTENT')!;
    expect(
      idempotent.transcript
        .filter((entry) => entry.direction === 'outbound')
        .map((e) => e.message_id)
    ).toEqual(['PCM-STABLE-1']);

    // Without messageId: unchanged behaviour, fresh ids and one entry per send.
    envelopeIds.length = 0;
    await send('PCS-FRESH');
    await send('PCS-FRESH');
    const fresh = loadPeerConversationSession(TENANT_ID, 'peer-a-test', 'PCS-FRESH')!;
    const outbound = fresh.transcript.filter((entry) => entry.direction === 'outbound');
    expect(outbound).toHaveLength(2);
    expect(new Set(envelopeIds).size).toBe(2);
    expect(new Set(outbound.map((entry) => entry.message_id)).size).toBe(2);

    await expect(send('PCS-FRESH', '../outside')).rejects.toThrow(
      'invalid_peer_conversation_message_id'
    );
    fetchSpy.mockRestore();
  });
});

describe('peer conversation tenant catalog (peer_catalog_reader)', () => {
  const tenant = 'zz-peer-catalog-test';
  const tenantRoot = pathResolver.knowledge(`confidential/${tenant}`);
  const otherTenantRoot = pathResolver.knowledge('confidential/zz-peer-catalog-other');

  afterEach(() => {
    vi.restoreAllMocks();
    clearPeerConversationRuntime(tenant, 'peer-a-test');
    clearPeerConversationRuntime(tenant, 'peer-b-test');
    withExecutionContext('ecosystem_architect', () => {
      safeRmSync(tenantRoot, { recursive: true, force: true });
      safeRmSync(otherTenantRoot, { recursive: true, force: true });
    });
  });

  function registerRecipient(tenantId: string): void {
    withExecutionContext('sovereign_concierge', () =>
      registerPeerNetworkPeer({
        tenantId,
        peerId: 'peer-b-test',
        baseUrl: 'http://127.0.0.1:4556',
        sharedSecret: SHARED_SECRET,
        exposure: 'same_host',
      })
    );
  }

  it('sends through the tenant confidential catalog without a confidential caller role', async () => {
    registerRecipient(tenant);
    // Pin the sender to a role without confidential read access so the test
    // does not depend on the ambient MISSION_ROLE (CI runs as mission_controller).
    const asSender = <T>(fn: () => Promise<T> | T): Promise<T> =>
      withExecutionContextAsync('infrastructure_sentinel', fn);
    await expect(
      asSender(() => safeReadFile(peerNetworkCatalogPath(tenant), { encoding: 'utf8' }))
    ).rejects.toThrow();

    const server = createPeerMessagingServer({
      peerId: 'peer-b-test',
      tenantId: tenant,
      sharedSecret: SHARED_SECRET,
      responder: createPeerConversationResponder({ peerId: 'peer-b-test', tenantId: tenant }),
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_input: unknown, init?: RequestInit) => {
        const result = await server.processEnvelope(JSON.parse(String(init?.body || '{}')));
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      }
    );

    const outcome = await asSender(() =>
      sendPeerConversationMessageToPeer({
        senderPeerId: 'peer-a-test',
        recipientPeerId: 'peer-b-test',
        tenantId: tenant,
        topic: 'handoff',
        text: 'reachable?',
        timeoutMs: 5000,
      })
    );
    expect(outcome.receipt.ok).toBe(true);
    expect(outcome.receipt.accepted).toBe(true);
  });

  it('grants only the bound tenant catalog and no other confidential file', () => {
    registerRecipient(tenant);
    registerRecipient('zz-peer-catalog-other');
    withExecutionContext('ecosystem_architect', () =>
      safeWriteFile(`${tenantRoot}/locale.json`, JSON.stringify({ locale: 'ja' }))
    );
    const asReader = <T>(fn: () => T): T =>
      withExecutionContext(PEER_CATALOG_READER_ROLE, fn, undefined, tenant);

    expect(
      asReader(() => safeReadFile(peerNetworkCatalogPath(tenant), { encoding: 'utf8' }))
    ).toContain('peer-b-test');
    expect(() =>
      asReader(() =>
        safeReadFile(peerNetworkCatalogPath('zz-peer-catalog-other'), { encoding: 'utf8' })
      )
    ).toThrow();
    expect(() =>
      asReader(() => safeReadFile(`${tenantRoot}/locale.json`, { encoding: 'utf8' }))
    ).toThrow();
    expect(() => asReader(() => safeWriteFile(peerNetworkCatalogPath(tenant), '{}'))).toThrow();
  });
});

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('peer conversation peer listing, transcript tails, and edges', () => {
  afterEach(() => {
    clearPeerConversationRuntime(TENANT_ID, 'peer-a-test');
    clearPeerConversationRuntime(TENANT_ID, 'peer-b-test');
  });

  it('lists tenants that have a peer-conversation runtime directory (AC-11)', () => {
    appendPeerConversationTranscript({
      tenantId: TENANT_ID,
      sessionId: 'PCS-tenants-1',
      localPeerId: 'peer-a-test',
      remotePeerId: 'peer-b-test',
      kind: 'message',
      direction: 'outbound',
      text: 'hello',
    });
    const tenants = listPeerConversationTenants();
    expect(tenants).toContain(TENANT_ID);
    // Sorted and free of non-tenant entries, so callers can hand each value
    // straight to `readPeerConversationEdges` without it throwing.
    expect([...tenants].sort()).toEqual(tenants);
    for (const tenant of tenants) {
      expect(() => readPeerConversationEdges(tenant)).not.toThrow();
    }
  });

  it('lists peers and returns the newest session tail per peer, truncated at 240 chars', async () => {
    // An older session for peer-a-test that must be superseded by the newer one below.
    appendPeerConversationTranscript({
      tenantId: TENANT_ID,
      sessionId: 'PCS-tails-a-old',
      localPeerId: 'peer-a-test',
      remotePeerId: 'peer-b-test',
      kind: 'open',
      direction: 'outbound',
      text: 'stale session, should not appear in the tail',
    });
    await sleepMs(5);

    const longText = 'x'.repeat(300);
    for (let index = 0; index < 6; index += 1) {
      appendPeerConversationTranscript({
        tenantId: TENANT_ID,
        sessionId: 'PCS-tails-a-new',
        localPeerId: 'peer-a-test',
        remotePeerId: 'peer-b-test',
        kind: index === 0 ? 'open' : 'message',
        direction: index % 2 === 0 ? 'outbound' : 'inbound',
        text: index === 5 ? longText : `message-${index}`,
      });
    }

    appendPeerConversationTranscript({
      tenantId: TENANT_ID,
      sessionId: 'PCS-tails-b',
      localPeerId: 'peer-b-test',
      remotePeerId: 'peer-a-test',
      kind: 'open',
      direction: 'outbound',
      text: 'hello from b',
    });

    expect(listPeerConversationPeers(TENANT_ID)).toEqual(['peer-a-test', 'peer-b-test']);

    const tails = collectPeerTranscriptTails(TENANT_ID);
    expect(tails).toHaveLength(2);

    const tailA = tails.find((tail) => tail.peer_id === 'peer-a-test');
    expect(tailA?.session_id).toBe('PCS-tails-a-new');
    expect(tailA?.remote_peer_id).toBe('peer-b-test');
    expect(tailA?.lines).toHaveLength(5);
    expect(tailA?.lines[0]?.text).toBe('message-1');
    expect(tailA?.lines[0]?.direction).toBe('inbound');
    expect(tailA?.lines[0]?.sender_peer_id).toBe('peer-b-test');
    const lastLine = tailA?.lines[tailA.lines.length - 1];
    expect(lastLine?.text).toHaveLength(240);
    expect(lastLine?.text).toBe(longText.slice(0, 240));
    expect(lastLine?.direction).toBe('inbound');
    expect(lastLine?.sender_peer_id).toBe('peer-b-test');

    const tailB = tails.find((tail) => tail.peer_id === 'peer-b-test');
    expect(tailB?.session_id).toBe('PCS-tails-b');
    expect(tailB?.lines).toHaveLength(1);

    const cappedTails = collectPeerTranscriptTails(TENANT_ID, { maxPerPeer: 2 });
    const cappedTailA = cappedTails.find((tail) => tail.peer_id === 'peer-a-test');
    expect(cappedTailA?.lines).toHaveLength(2);
  });

  it('derives edges from observability events with orientation, since filter, limit, and malformed-line skipping', async () => {
    appendPeerConversationTranscript({
      tenantId: TENANT_ID,
      sessionId: 'PCS-edge-1',
      localPeerId: 'peer-a-test',
      remotePeerId: 'peer-b-test',
      kind: 'message',
      direction: 'outbound',
      text: 'hello',
    });
    await sleepMs(5);
    appendPeerConversationTranscript({
      tenantId: TENANT_ID,
      sessionId: 'PCS-edge-1',
      localPeerId: 'peer-a-test',
      remotePeerId: 'peer-b-test',
      kind: 'reply',
      direction: 'inbound',
      text: 'hi back',
    });

    const allEdges = readPeerConversationEdges(TENANT_ID);
    expect(allEdges).toHaveLength(2);
    expect(allEdges[0]).toMatchObject({
      tenant_id: TENANT_ID,
      sender_peer_id: 'peer-a-test',
      receiver_peer_id: 'peer-b-test',
      session_id: 'PCS-edge-1',
      kind: 'message',
    });
    expect(allEdges[1]).toMatchObject({
      sender_peer_id: 'peer-b-test',
      receiver_peer_id: 'peer-a-test',
      kind: 'reply',
    });
    expect(allEdges[0].ts <= allEdges[1].ts).toBe(true);

    const sinceEdges = readPeerConversationEdges(TENANT_ID, { since: allEdges[1].ts });
    expect(sinceEdges).toHaveLength(1);
    expect(sinceEdges[0].kind).toBe('reply');

    const limitedEdges = readPeerConversationEdges(TENANT_ID, { limit: 1 });
    expect(limitedEdges).toHaveLength(1);
    expect(limitedEdges[0].kind).toBe('reply');

    const eventsFilePath = pathResolver.shared(
      `observability/peer-conversations/tenants/${TENANT_ID}/peers/peer-a-test/events.jsonl`
    );
    withExecutionContext('infrastructure_sentinel', () => {
      safeAppendFile(eventsFilePath, 'not-json-at-all\n');
    });

    const edgesAfterCorruption = readPeerConversationEdges(TENANT_ID);
    expect(edgesAfterCorruption).toHaveLength(2);
  });

  it('returns empty arrays for an invalid tenant id without throwing', () => {
    expect(listPeerConversationPeers('../outside')).toEqual([]);
    expect(collectPeerTranscriptTails('../outside')).toEqual([]);
    expect(readPeerConversationEdges('../outside')).toEqual([]);
  });
});
