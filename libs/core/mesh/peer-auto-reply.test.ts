import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const { runClaudeAgentQueryMock, getReasoningBackendSpy } = vi.hoisted(() => ({
  runClaudeAgentQueryMock: vi.fn(),
  getReasoningBackendSpy: vi.fn(),
}));

vi.mock('../provider/claude-agent-query.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../provider/claude-agent-query.js')>()),
  runClaudeAgentQuery: runClaudeAgentQueryMock,
}));

vi.mock('../reasoning/reasoning-backend.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../reasoning/reasoning-backend.js')>();
  getReasoningBackendSpy.mockImplementation(actual.getReasoningBackend);
  return { ...actual, getReasoningBackend: getReasoningBackendSpy };
});

import { getReasoningPayloadScope } from '../reasoning/reasoning-egress-scope.js';
import {
  clearPeerRuntime,
  createPeerMessagingServer,
  type PeerMessageEnvelope,
} from './peer-messaging.js';
import {
  appendPeerConversationTranscript,
  buildPeerConversationEnvelope,
  clearPeerConversationRuntime,
  createPeerConversationResponder,
  loadPeerConversationSession,
  type PeerConversationMessageKind,
} from './peer-conversation.js';
import {
  createPeerAutoReply,
  defaultPeerAutoReplyGenerate,
  deliverPeerAutoReply,
  listPeerReplyJobs,
  peerReplyJobKey,
  peerReplyMessageId,
  selectPeerAutoReplyHistory,
  type PeerAutoReplyConfig,
  type PeerAutoReplyDeliverInput,
  type PeerAutoReplyGenerateInput,
  type PeerReplyJob,
} from './peer-auto-reply.js';
import { peerRuntimeLogicalPath } from './peer-messaging.js';
import { appendGovernedArtifactJsonl } from '../workforce/artifact-store.js';
import { withExecutionContext } from '../authority.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeRmSync, safeWriteFile } from '../secure-io.js';

const TENANT = 'tenant-peer-autoreply';
const LOCAL = 'peer-autoreply-local';
const REMOTE = 'peer-autoreply-remote';
const OTHER = 'peer-autoreply-other';
const SESSION = 'PCS-AUTO-REPLY-1';
const SHARED_SECRET = 'peer-auto-reply-secret';
const CATALOG_PATH = pathResolver.sharedTmp('peer-auto-reply-catalog.test.json');

afterEach(() => {
  vi.restoreAllMocks();
  clearPeerRuntime(TENANT, LOCAL);
  clearPeerRuntime(TENANT, REMOTE);
  clearPeerConversationRuntime(TENANT, LOCAL);
  clearPeerConversationRuntime(TENANT, REMOTE);
  if (safeExistsSync(CATALOG_PATH)) safeRmSync(CATALOG_PATH, { force: true });
  vi.clearAllMocks();
});

// Per-peer clears leave the (empty) tenant directories; this tenant is test-only.
afterAll(() => {
  withExecutionContext('infrastructure_sentinel', () => {
    for (const root of ['runtime', 'observability']) {
      for (const area of ['peer-conversations', 'peer-messaging']) {
        const dir = pathResolver.resolve(`active/shared/${root}/${area}/tenants/${TENANT}`);
        if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

function inbound(input: {
  messageId: string;
  text?: string;
  kind?: PeerConversationMessageKind;
  metadata?: Record<string, unknown>;
  sender?: string;
  sessionId?: string;
}) {
  const sender = input.sender ?? REMOTE;
  const session = appendPeerConversationTranscript({
    tenantId: TENANT,
    sessionId: input.sessionId ?? SESSION,
    localPeerId: LOCAL,
    remotePeerId: sender,
    kind: input.kind ?? 'message',
    direction: 'inbound',
    text: input.text ?? `hello ${input.messageId}`,
    metadata: input.metadata,
    messageId: input.messageId,
    payload: { topic: 'auto-reply-topic' },
  });
  return {
    session,
    message: session.transcript[session.transcript.length - 1],
    envelope: {
      tenant_id: TENANT,
      sender_peer_id: sender,
      recipient_peer_id: LOCAL,
      message_id: input.messageId,
    } as unknown as PeerMessageEnvelope<unknown>,
  };
}

function recordOutboundAuto(text: string, sessionId = SESSION) {
  appendPeerConversationTranscript({
    tenantId: TENANT,
    sessionId,
    localPeerId: LOCAL,
    remotePeerId: REMOTE,
    kind: 'reply',
    direction: 'outbound',
    text,
    metadata: { auto_generated: true, auto_turn: 1 },
  });
}

function setup(overrides: Partial<PeerAutoReplyConfig> = {}) {
  const generate = vi.fn(async (_input: PeerAutoReplyGenerateInput) => '  generated reply  ');
  const deliver = vi.fn(async (_input: PeerAutoReplyDeliverInput) => ({ status: 200 }));
  const retrieveKnowledge = vi.fn(async () => [
    {
      path: 'knowledge/confidential/tenant-peer-autoreply/faq.md',
      title: 'FAQ',
      excerpt: 'Office hours are 9-17.',
      tags: [],
      score: 1,
      tenant_slug: TENANT,
    },
  ]);
  const autoReply = createPeerAutoReply({
    tenantId: TENANT,
    localPeerId: LOCAL,
    enabledPeers: [REMOTE],
    deliveryBackoffMs: 0,
    generate,
    deliver,
    retrieveKnowledge,
    ...overrides,
  });
  return { autoReply, generate, deliver, retrieveKnowledge };
}

describe('peer auto-reply', () => {
  it('is opt-in: a non-enabled peer gets no job and keeps the default echo', async () => {
    const { autoReply, generate } = setup({ enabledPeers: [OTHER] });
    expect(autoReply.handleInbound(inbound({ messageId: 'M-1' }))).toBeUndefined();
    const disabled = setup({ enabledPeers: [] });
    expect(disabled.autoReply.enabled).toBe(false);
    expect(disabled.autoReply.handleInbound(inbound({ messageId: 'M-2' }))).toBeUndefined();
    expect(listPeerReplyJobs(TENANT, LOCAL)).toEqual([]);
    await autoReply.runOnce();
    expect(generate).not.toHaveBeenCalled();

    // Through the real responder: the echo stays when the hook declines.
    const responder = createPeerConversationResponder({
      peerId: LOCAL,
      tenantId: TENANT,
      onMessage: (context) => autoReply.handleInbound(context),
    });
    const envelope = buildPeerConversationEnvelope({
      tenantId: TENANT,
      senderPeerId: REMOTE,
      recipientPeerId: LOCAL,
      sharedSecret: 'peer-auto-reply-secret',
      sessionId: SESSION,
      topic: 'auto-reply-topic',
      text: 'ping',
    });
    const result = (await responder({ peerId: LOCAL, envelope })) as {
      reply: { kind: string; text: string };
    };
    expect(result.reply.kind).toBe('reply');
    expect(result.reply.text).toBe(`Received by ${LOCAL}: ping`);
  });

  it('acks through the responder with a status reply and enqueues without generating', async () => {
    const { autoReply, generate } = setup();
    const responder = createPeerConversationResponder({
      peerId: LOCAL,
      tenantId: TENANT,
      onMessage: (context) => autoReply.handleInbound(context),
    });
    const envelope = buildPeerConversationEnvelope({
      tenantId: TENANT,
      senderPeerId: REMOTE,
      recipientPeerId: LOCAL,
      sharedSecret: 'peer-auto-reply-secret',
      sessionId: SESSION,
      topic: 'auto-reply-topic',
      text: 'ping',
    });
    const result = (await responder({ peerId: LOCAL, envelope })) as {
      reply: { kind: string; text: string; metadata: Record<string, unknown> };
    };
    expect(result.reply.kind).toBe('status');
    expect(result.reply.metadata).toEqual({ ack: true, reply_job: 'queued' });
    expect(result.reply.text).toBe(`Queued for reply by ${LOCAL}`);
    expect(generate).not.toHaveBeenCalled();
    const jobs = listPeerReplyJobs(TENANT, LOCAL);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      key: peerReplyJobKey(REMOTE, envelope.message_id),
      status: 'queued',
      inbound_text: 'ping',
      inbound_auto_turn: 0,
    });
  });

  it('dedups: the same message twice yields one job, one generation and one delivery', async () => {
    const { autoReply, generate, deliver } = setup();
    const context = inbound({ messageId: 'M-DUP' });
    expect(autoReply.handleInbound(context)?.reply?.metadata).toEqual({
      ack: true,
      reply_job: 'queued',
    });
    expect(autoReply.handleInbound(context)?.reply?.kind).toBe('status');
    await autoReply.runOnce();
    expect(autoReply.handleInbound(context)?.reply?.metadata).toEqual({
      ack: true,
      reply_job: 'delivered',
    });
    await autoReply.runOnce();
    expect(listPeerReplyJobs(TENANT, LOCAL)).toHaveLength(1);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('caps the loop via inbound auto_turn and via replies already sent in the session', () => {
    const { autoReply } = setup({ maxTurns: 2 });
    // Human (non-auto) message at the cap keeps the default behaviour.
    expect(autoReply.handleInbound(inbound({ messageId: 'M-H', metadata: { auto_turn: 2 } }))).toBe(
      undefined
    );
    // Auto-generated message at the cap gets a status ACK and a skipped row.
    const capped = autoReply.handleInbound(
      inbound({ messageId: 'M-A', metadata: { auto_generated: true, auto_turn: 2 } })
    );
    expect(capped?.reply).toMatchObject({
      kind: 'status',
      metadata: { ack: true, reply_job: 'skipped' },
    });
    expect(
      autoReply.handleInbound(inbound({ messageId: 'M-B', metadata: { auto_turn: 1 } }))?.reply
        ?.metadata
    ).toEqual({ ack: true, reply_job: 'queued' });

    // Per-session cap is counted from the ledger, not the (truncatable) transcript:
    // transcript-only auto entries do not count, two reply jobs in the session do.
    const session2 = 'PCS-AUTO-REPLY-2';
    recordOutboundAuto('one', session2);
    recordOutboundAuto('two', session2);
    for (const id of ['M-S1', 'M-S2']) {
      expect(
        autoReply.handleInbound(inbound({ messageId: id, sessionId: session2 }))?.reply?.metadata
      ).toEqual({ ack: true, reply_job: 'queued' });
    }
    const sentCapped = autoReply.handleInbound(
      inbound({
        messageId: 'M-C',
        sessionId: session2,
        metadata: { auto_generated: true, auto_turn: 1 },
      })
    );
    expect(sentCapped?.reply?.metadata).toEqual({ ack: true, reply_job: 'skipped' });

    const jobs = new Map(listPeerReplyJobs(TENANT, LOCAL).map((job) => [job.message_id, job]));
    expect(jobs.get('M-H')).toBeUndefined();
    expect(jobs.get('M-A')).toMatchObject({ status: 'skipped', reason: 'inbound_auto_turn_cap' });
    expect(jobs.get('M-B')).toMatchObject({ status: 'queued', inbound_auto_turn: 1 });
    expect(jobs.get('M-C')).toMatchObject({ status: 'skipped', reason: 'session_auto_reply_cap' });
  });

  it('ignores open, close, status and handoff kinds', () => {
    const { autoReply } = setup();
    for (const kind of ['open', 'close', 'status', 'handoff'] as const) {
      expect(autoReply.handleInbound(inbound({ messageId: `M-${kind}`, kind }))).toBeUndefined();
    }
    expect(autoReply.handleInbound(inbound({ messageId: 'M-reply', kind: 'reply' }))).toBeDefined();
    expect(listPeerReplyJobs(TENANT, LOCAL).map((job) => job.message_id)).toEqual(['M-reply']);
  });

  it('filters history to the job session without status/ack entries and caps characters', async () => {
    // Another session with the same peer and a session with another peer.
    inbound({ messageId: 'M-OTHER-SESSION', sessionId: 'PCS-AUTO-REPLY-X', text: 'secret-x' });
    inbound({ messageId: 'M-OTHER-PEER', sessionId: 'PCS-AUTO-REPLY-Y', sender: OTHER });
    inbound({ messageId: 'M-H1', text: 'first human line' });
    appendPeerConversationTranscript({
      tenantId: TENANT,
      sessionId: SESSION,
      localPeerId: LOCAL,
      remotePeerId: REMOTE,
      kind: 'status',
      direction: 'outbound',
      text: 'Queued for reply',
      metadata: { ack: true, reply_job: 'queued' },
    });
    appendPeerConversationTranscript({
      tenantId: TENANT,
      sessionId: SESSION,
      localPeerId: LOCAL,
      remotePeerId: REMOTE,
      kind: 'reply',
      direction: 'inbound',
      text: 'ack-flagged reply',
      metadata: { ack: true },
    });
    recordOutboundAuto('our earlier auto reply');
    const context = inbound({ messageId: 'M-NOW', text: 'what are office hours?' });
    const job = {
      tenant_id: TENANT,
      local_peer_id: LOCAL,
      sender_peer_id: REMOTE,
      session_id: SESSION,
      message_id: 'M-NOW',
    };
    const history = selectPeerAutoReplyHistory(context.session, job);
    expect(history.map((entry) => entry.text)).toEqual([
      'first human line',
      'our earlier auto reply',
    ]);
    expect(
      selectPeerAutoReplyHistory(context.session, job, { maxChars: 30 }).map((e) => e.text)
    ).toEqual(['our earlier auto reply']);
    expect(() =>
      selectPeerAutoReplyHistory(context.session, { ...job, sender_peer_id: OTHER })
    ).toThrow('peer_auto_reply_session_mismatch');

    // The worker prompt carries only this session's history, framed as untrusted.
    const { autoReply, generate } = setup();
    autoReply.handleInbound(context);
    await autoReply.runOnce();
    const prompt = generate.mock.calls[0][0];
    expect(prompt.userPrompt).toContain('first human line');
    expect(prompt.userPrompt).not.toContain('secret-x');
    expect(prompt.userPrompt).not.toContain('Queued for reply');
    expect(prompt.userPrompt).not.toContain('ack-flagged reply');
    expect(prompt.userPrompt).toContain('<untrusted_data source="tenant-knowledge">');
    expect(prompt.userPrompt).toContain(`<untrusted_data source="peer:${REMOTE}">`);
    expect(prompt.userPrompt).toContain(`<untrusted_data source="peer-conversation:${SESSION}">`);
    expect(prompt.systemPrompt).toContain('You have no tools');
    expect(prompt.systemPrompt).toContain(`talking with peer ${REMOTE}`);
  });

  it('records generation failures separately and never delivers them', async () => {
    const { autoReply, deliver } = setup({
      generate: vi.fn(async () => {
        throw Object.assign(new Error('boom'), { code: 'agent_error' });
      }),
    });
    autoReply.handleInbound(inbound({ messageId: 'M-GF' }));
    await autoReply.runOnce();
    const jobs = new Map(listPeerReplyJobs(TENANT, LOCAL).map((job) => [job.message_id, job]));
    expect(jobs.get('M-GF')).toMatchObject({
      status: 'generation_failed',
      generation: { attempts: 1, error_code: 'agent_error', error_message: 'boom' },
    });
    expect(deliver).not.toHaveBeenCalled();
    const empty = setup({ generate: vi.fn(async () => '   ') });
    empty.autoReply.handleInbound(inbound({ messageId: 'M-EMPTY' }));
    await empty.autoReply.runOnce();

    expect(
      listPeerReplyJobs(TENANT, LOCAL).find((job) => job.message_id === 'M-EMPTY')
    ).toMatchObject({ status: 'generation_failed', generation: { error_code: 'empty_reply' } });
  });

  it('times out generation', async () => {
    const { autoReply } = setup({
      generationTimeoutMs: 20,
      generate: vi.fn((input: PeerAutoReplyGenerateInput) => {
        return new Promise<string>((_, reject) =>
          input.signal.addEventListener('abort', () => reject(new Error('aborted')))
        );
      }),
    });
    autoReply.handleInbound(inbound({ messageId: 'M-TO' }));
    const [job] = await autoReply.runOnce();
    expect(job.status).toBe('generation_failed');
    expect(job.generation?.error_code).toBe('timeout');
    expect(typeof job.generation?.duration_ms).toBe('number');
  });

  it('retries delivery without re-generating and records delivery_failed when exhausted', async () => {
    const flaky = vi
      .fn<(input: PeerAutoReplyDeliverInput) => Promise<{ status: number }>>()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ status: 200 });
    const ok = setup({ deliver: flaky });
    ok.autoReply.handleInbound(inbound({ messageId: 'M-RETRY' }));
    const [delivered] = await ok.autoReply.runOnce();
    expect(delivered).toMatchObject({
      status: 'delivered',
      reply_text: 'generated reply',
      delivery: { attempts: 2, receipt_status: 200 },
    });
    expect(ok.generate).toHaveBeenCalledTimes(1);
    expect(flaky).toHaveBeenCalledTimes(2);
    const stableId = peerReplyMessageId(peerReplyJobKey(REMOTE, 'M-RETRY'));
    expect(flaky.mock.calls.map(([call]) => call.messageId)).toEqual([stableId, stableId]);
    expect(delivered.reply_message_id).toBe(stableId);

    const down = vi.fn(async () => {
      throw new Error('peer down');
    });
    const failing = setup({ maxDeliveryAttempts: 3, deliver: down });
    failing.autoReply.handleInbound(inbound({ messageId: 'M-DF' }));
    const [failed] = await failing.autoReply.runOnce();
    expect(failed).toMatchObject({
      status: 'delivery_failed',
      reply_text: 'generated reply',
      generation: { attempts: 1 },
      delivery: { attempts: 3, error_message: 'peer down' },
    });
    expect(down).toHaveBeenCalledTimes(3);
    expect(failing.generate).toHaveBeenCalledTimes(1);
  });

  it('recovers on restart: stale generating is requeued, queued resumes, fresh leases stay', async () => {
    const base = {
      tenant_id: TENANT,
      local_peer_id: LOCAL,
      sender_peer_id: REMOTE,
      session_id: SESSION,
      topic: 'auto-reply-topic',
      inbound_auto_turn: 0,
      enqueued_at: '2026-10-18T00:00:00.000Z',
      updated_at: '2026-10-18T00:00:00.000Z',
    };
    inbound({ messageId: 'M-STALE', text: 'stale' });
    inbound({ messageId: 'M-QUEUED', text: 'queued' });
    inbound({ messageId: 'M-FRESH', text: 'fresh' });
    inbound({ messageId: 'M-DELIVERING', text: 'delivering' });
    const ledger = peerRuntimeLogicalPath(TENANT, LOCAL, 'reply-jobs.jsonl');
    const rows: PeerReplyJob[] = [
      {
        ...base,
        key: peerReplyJobKey(REMOTE, 'M-STALE'),
        message_id: 'M-STALE',
        inbound_text: 'stale',
        status: 'generating',
        lease_at: '2026-10-18T00:00:00.000Z',
      },
      {
        ...base,
        key: peerReplyJobKey(REMOTE, 'M-QUEUED'),
        message_id: 'M-QUEUED',
        inbound_text: 'queued',
        status: 'queued',
      },
      {
        ...base,
        key: peerReplyJobKey(REMOTE, 'M-FRESH'),
        message_id: 'M-FRESH',
        inbound_text: 'fresh',
        status: 'generating',
        lease_at: '2026-10-18T00:09:59.000Z',
      },
      {
        ...base,
        key: peerReplyJobKey(REMOTE, 'M-DELIVERING'),
        message_id: 'M-DELIVERING',
        inbound_text: 'delivering',
        status: 'delivering',
        reply_text: 'already generated',
        lease_at: '2026-10-18T00:00:00.000Z',
        delivery: { attempts: 1 },
      },
    ];
    for (const row of rows) appendGovernedArtifactJsonl('infrastructure_sentinel', ledger, row);

    const { autoReply, generate, deliver } = setup({
      staleLeaseMs: 60_000,
      now: () => Date.parse('2026-10-18T00:10:00.000Z'),
    });
    await autoReply.runOnce();
    const jobs = new Map(listPeerReplyJobs(TENANT, LOCAL).map((job) => [job.message_id, job]));
    expect(jobs.get('M-STALE')?.status).toBe('delivered');
    expect(jobs.get('M-QUEUED')?.status).toBe('delivered');
    expect(jobs.get('M-FRESH')?.status).toBe('generating');
    expect(jobs.get('M-DELIVERING')).toMatchObject({
      status: 'delivered',
      reply_text: 'already generated',
      delivery: { attempts: 2 },
    });
    // Two generations (stale + queued); the delivering job reused its reply.
    expect(generate).toHaveBeenCalledTimes(2);
    expect(deliver).toHaveBeenCalledTimes(3);
  });

  it('delivers a reply-kind message linked to the inbound with auto_turn + 1', async () => {
    const { autoReply, deliver } = setup();
    autoReply.handleInbound(
      inbound({ messageId: 'M-SHAPE', metadata: { auto_generated: true, auto_turn: 3 } })
    );
    await autoReply.runOnce();
    expect(deliver).toHaveBeenCalledWith({
      tenantId: TENANT,
      localPeerId: LOCAL,
      recipientPeerId: REMOTE,
      sessionId: SESSION,
      topic: 'auto-reply-topic',
      text: 'generated reply',
      replyToMessageId: 'M-SHAPE',
      messageId: peerReplyMessageId(peerReplyJobKey(REMOTE, 'M-SHAPE')),
      metadata: { auto_generated: true, auto_turn: 4 },
    });
    expect(loadPeerConversationSession(TENANT, LOCAL, SESSION)).not.toBeNull();
  });

  it('counts a duplicate receipt as delivered', async () => {
    const { autoReply } = setup({
      deliver: vi.fn(async () => ({ status: 200, duplicate: true })),
    });
    autoReply.handleInbound(inbound({ messageId: 'M-DUPRCPT' }));
    const [job] = await autoReply.runOnce();
    expect(job).toMatchObject({
      status: 'delivered',
      delivery: { attempts: 1, receipt_status: 200, duplicate: true },
    });
  });

  it('retries delivery end to end idempotently: one envelope id, one transcript entry', async () => {
    safeWriteFile(
      CATALOG_PATH,
      JSON.stringify({
        version: '1',
        tenant_id: TENANT,
        peers: [
          {
            peer_id: REMOTE,
            base_url: 'http://127.0.0.1:4556',
            shared_secret: SHARED_SECRET,
            allow_local_network: true,
          },
        ],
      })
    );
    const remote = createPeerMessagingServer({
      peerId: REMOTE,
      tenantId: TENANT,
      sharedSecret: SHARED_SECRET,
      responder: createPeerConversationResponder({ peerId: REMOTE, tenantId: TENANT }),
    });
    const sentIds: string[] = [];
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (_input: unknown, init?: RequestInit) => {
        const envelope = JSON.parse(String(init?.body || '{}'));
        sentIds.push(envelope.message_id);
        calls += 1;
        if (calls === 1) throw new TypeError('fetch failed');
        const result = await remote.processEnvelope(envelope);
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
      }
    );

    const deliver = vi.fn((input: PeerAutoReplyDeliverInput) =>
      deliverPeerAutoReply(input, { catalogPath: CATALOG_PATH })
    );
    const { autoReply } = setup({ deliver });
    autoReply.handleInbound(inbound({ messageId: 'M-E2E' }));
    const [job] = await autoReply.runOnce();
    const stableId = peerReplyMessageId(peerReplyJobKey(REMOTE, 'M-E2E'));
    expect(job).toMatchObject({
      status: 'delivered',
      reply_message_id: stableId,
      delivery: { attempts: 2 },
    });
    expect(sentIds).toEqual([stableId, stableId]);

    // A resend of the same reply is deduped by the recipient and counts as delivered.
    const resend = await deliverPeerAutoReply(deliver.mock.calls[0][0], {
      catalogPath: CATALOG_PATH,
    });
    expect(resend).toEqual({ status: 200, duplicate: true });
    expect(sentIds).toEqual([stableId, stableId, stableId]);

    const autoEntries = loadPeerConversationSession(TENANT, LOCAL, SESSION)!.transcript.filter(
      (entry) => entry.direction === 'outbound' && entry.metadata?.auto_generated === true
    );
    expect(autoEntries).toHaveLength(1);
    expect(autoEntries[0].message_id).toBe(stableId);
    const remoteReplies = loadPeerConversationSession(TENANT, REMOTE, SESSION)!.transcript.filter(
      (entry) => entry.message_id === stableId
    );
    expect(remoteReplies).toHaveLength(1);
  });

  it('rejects a third peer injecting into another pair session and never feeds it to history', async () => {
    const responder = createPeerConversationResponder({ peerId: LOCAL, tenantId: TENANT });
    const envelopeFrom = (sender: string, text: string) =>
      buildPeerConversationEnvelope({
        tenantId: TENANT,
        senderPeerId: sender,
        recipientPeerId: LOCAL,
        sharedSecret: SHARED_SECRET,
        sessionId: SESSION,
        topic: 'auto-reply-topic',
        text,
      });
    await responder({ peerId: LOCAL, envelope: envelopeFrom(REMOTE, 'legit line') });
    await expect(
      responder({ peerId: LOCAL, envelope: envelopeFrom(OTHER, 'INJECTED by C') })
    ).rejects.toThrow(`peer_conversation_session_peer_mismatch:${SESSION}`);
    const session = loadPeerConversationSession(TENANT, LOCAL, SESSION)!;
    expect(session.remote_peer_id).toBe(REMOTE);
    expect(session.transcript.some((entry) => entry.text.includes('INJECTED'))).toBe(false);
    // A new session from the third peer is still fine.
    await expect(
      responder({
        peerId: LOCAL,
        envelope: buildPeerConversationEnvelope({
          tenantId: TENANT,
          senderPeerId: OTHER,
          recipientPeerId: LOCAL,
          sharedSecret: SHARED_SECRET,
          sessionId: 'PCS-AUTO-REPLY-C',
          topic: 'auto-reply-topic',
          text: 'hello from C',
        }),
      })
    ).resolves.toBeDefined();

    // Defence in depth: even an entry written into the session by another
    // path is dropped unless it belongs to the {local, remote} pair.
    appendPeerConversationTranscript({
      tenantId: TENANT,
      sessionId: SESSION,
      localPeerId: LOCAL,
      remotePeerId: OTHER,
      kind: 'message',
      direction: 'inbound',
      text: 'INJECTED via storage',
    });
    const context = inbound({ messageId: 'M-AFTER', text: 'question' });
    const job = {
      tenant_id: TENANT,
      local_peer_id: LOCAL,
      sender_peer_id: REMOTE,
      session_id: SESSION,
      message_id: 'M-AFTER',
    };
    const history = selectPeerAutoReplyHistory(context.session, job);
    expect(history.map((entry) => entry.text)).toEqual([
      'legit line',
      `Received by ${LOCAL}: legit line`,
    ]);
    const { autoReply, generate } = setup();
    autoReply.handleInbound(context);
    await autoReply.runOnce();
    expect(generate.mock.calls[0][0].userPrompt).not.toContain('INJECTED');
  });

  it('enforces a rolling per-peer hourly budget across sessions', () => {
    let clock = Date.parse('2026-10-18T00:00:00.000Z');
    const { autoReply } = setup({ budgetPerHour: 2, now: () => clock });
    const send = (id: string) =>
      autoReply.handleInbound(inbound({ messageId: id, sessionId: `PCS-BUDGET-${id}` }))?.reply
        ?.metadata;
    expect(send('B1')).toEqual({ ack: true, reply_job: 'queued' });
    expect(send('B2')).toEqual({ ack: true, reply_job: 'queued' });
    // Rotating session ids does not escape the budget.
    expect(send('B3')).toEqual({ ack: true, reply_job: 'skipped' });
    expect(autoReply.listJobs().find((job) => job.message_id === 'B3')).toMatchObject({
      status: 'skipped',
      reason: 'peer_budget_exhausted',
    });
    clock += 60 * 60 * 1000 + 1;
    expect(send('B4')).toEqual({ ack: true, reply_job: 'queued' });
  });

  it('recovers stale leases on every pass and fails exhausted generations', async () => {
    let clock = Date.parse('2026-10-18T00:10:00.000Z');
    const base = {
      tenant_id: TENANT,
      local_peer_id: LOCAL,
      sender_peer_id: REMOTE,
      session_id: SESSION,
      topic: 'auto-reply-topic',
      inbound_auto_turn: 0,
      enqueued_at: '2026-10-18T00:00:00.000Z',
      updated_at: '2026-10-18T00:00:00.000Z',
    };
    inbound({ messageId: 'M-LATER', text: 'later' });
    const ledger = peerRuntimeLogicalPath(TENANT, LOCAL, 'reply-jobs.jsonl');
    const rows: PeerReplyJob[] = [
      {
        ...base,
        key: peerReplyJobKey(REMOTE, 'M-LATER'),
        message_id: 'M-LATER',
        inbound_text: 'later',
        status: 'generating',
        lease_at: '2026-10-18T00:09:30.000Z',
        generation: { attempts: 1 },
      },
      {
        ...base,
        key: peerReplyJobKey(REMOTE, 'M-EXHAUSTED'),
        message_id: 'M-EXHAUSTED',
        inbound_text: 'exhausted',
        status: 'generating',
        lease_at: '2026-10-18T00:00:00.000Z',
        generation: { attempts: 2 },
      },
    ];
    for (const row of rows) appendGovernedArtifactJsonl('infrastructure_sentinel', ledger, row);
    const { autoReply, generate } = setup({ staleLeaseMs: 60_000, now: () => clock });

    await autoReply.runOnce();
    const first = new Map(autoReply.listJobs().map((job) => [job.message_id, job]));
    expect(first.get('M-EXHAUSTED')).toMatchObject({
      status: 'generation_failed',
      generation: { error_code: 'attempts_exhausted' },
    });
    expect(first.get('M-LATER')?.status).toBe('generating');
    expect(generate).not.toHaveBeenCalled();

    clock += 60_000;
    await autoReply.runOnce();
    expect(autoReply.listJobs().find((job) => job.message_id === 'M-LATER')).toMatchObject({
      status: 'delivered',
      generation: { attempts: 2 },
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('stop() aborts in-flight generation and requeues the job without delivering', async () => {
    const generate = vi.fn(
      (input: PeerAutoReplyGenerateInput) =>
        new Promise<string>(() => {
          // Never settles on its own; ignores nothing but proves stop does not wait for it.
          void input;
        })
    );
    const { autoReply, deliver } = setup({ generate });
    autoReply.handleInbound(inbound({ messageId: 'M-STOP-GEN' }));
    const pass = autoReply.runOnce();
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    expect(generate.mock.calls[0][0].signal.aborted).toBe(false);
    await autoReply.stop();
    expect(generate.mock.calls[0][0].signal.aborted).toBe(true);
    await pass;
    expect(autoReply.listJobs()[0]).toMatchObject({
      status: 'queued',
      reason: 'requeued_on_stop',
    });
    expect(autoReply.listJobs()[0].generation).toBeUndefined();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('stop() during delivery backoff requeues with the generated reply and delivers nothing more', async () => {
    let releaseSleep: () => void = () => undefined;
    const deliver = vi.fn(async () => {
      throw new Error('peer down');
    });
    const { autoReply, generate } = setup({
      deliver,
      deliveryBackoffMs: 10,
      sleep: () => new Promise<void>((resolve) => (releaseSleep = resolve)),
    });
    autoReply.handleInbound(inbound({ messageId: 'M-STOP-DEL' }));
    const pass = autoReply.runOnce();
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    const stopping = autoReply.stop();
    releaseSleep();
    await stopping;
    await pass;
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(autoReply.listJobs()[0]).toMatchObject({
      status: 'queued',
      reason: 'requeued_on_stop',
      reply_text: 'generated reply',
      delivery: { attempts: 1 },
    });
    expect(await autoReply.runOnce()).toEqual([]);
  });

  it('keeps an in-memory index: loaded once, updated on its own appends', () => {
    const { autoReply } = setup();
    autoReply.handleInbound(inbound({ messageId: 'M-IDX-1' }));
    // A row written by another (unsupported) writer is not re-read per call.
    appendGovernedArtifactJsonl(
      'infrastructure_sentinel',
      peerRuntimeLogicalPath(TENANT, LOCAL, 'reply-jobs.jsonl'),
      {
        key: peerReplyJobKey(REMOTE, 'M-IDX-EXTERNAL'),
        status: 'queued',
        message_id: 'M-IDX-EXTERNAL',
      }
    );
    expect(autoReply.listJobs().map((job) => job.message_id)).toEqual(['M-IDX-1']);
    expect(listPeerReplyJobs(TENANT, LOCAL)).toHaveLength(2);
    expect(setup().autoReply.listJobs()).toHaveLength(2);
  });

  it('fails open to no knowledge when retrieval throws', async () => {
    const { autoReply, generate } = setup({
      retrieveKnowledge: vi.fn(async () => {
        throw new Error('role not registered');
      }),
    });
    autoReply.handleInbound(inbound({ messageId: 'M-KF' }));
    const [job] = await autoReply.runOnce();
    expect(job.status).toBe('delivered');
    expect(generate.mock.calls[0][0].userPrompt).not.toContain('tenant-knowledge');
  });

  it('default generate runs runClaudeAgentQuery inside the confidential zero_retention scope', async () => {
    let observedScope: unknown;
    runClaudeAgentQueryMock.mockImplementation(async (params: Record<string, unknown>) => {
      observedScope = getReasoningPayloadScope();
      expect(params.abortController).toBeInstanceOf(AbortController);
      expect(params.systemPrompt).toBe('system');
      expect(params.userPrompt).toBe('user');
      expect(params.isolation).toBe('strict');
      return {
        parsed: { reply: 'hi there' },
        raw: {},
        sessionId: '',
        totalCostUsd: 0,
        numTurns: 1,
      };
    });
    const reply = await defaultPeerAutoReplyGenerate({
      tenantId: TENANT,
      localPeerId: LOCAL,
      remotePeerId: REMOTE,
      systemPrompt: 'system',
      userPrompt: 'user',
      signal: new AbortController().signal,
    });
    expect(reply).toBe('hi there');
    expect(runClaudeAgentQueryMock).toHaveBeenCalledTimes(1);
    expect(observedScope).toEqual({
      tier: 'confidential',
      tenant_slug: TENANT,
      purpose: 'peer-conversation:auto-reply',
      training_use: 'zero_retention',
    });
    expect(getReasoningBackendSpy).not.toHaveBeenCalled();
  });
});
