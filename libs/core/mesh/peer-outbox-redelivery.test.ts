import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildPeerMessageEnvelope,
  classifyPeerDeliveryFailure,
  clearPeerRuntime,
  createPeerMessagingServer,
  listPeerInboxRecords,
  listPeerOutboxRecords,
  peerRuntimeLogicalPath,
  sendPeerMessage,
  type PeerMessageEnvelope,
  type PeerNetworkCatalog,
} from './peer-messaging.js';
import {
  clearPeerConversationRuntime,
  createPeerConversationResponder,
  loadPeerConversationSession,
  sendPeerConversationMessageToPeer,
} from './peer-conversation.js';
import { deliverPeerAutoReply } from './peer-auto-reply.js';
import { appendGovernedArtifactJsonl } from '../workforce/artifact-store.js';
import { pathResolver } from '../path-resolver.js';
import { safeRmSync, safeWriteFile } from '../secure-io.js';
import {
  applyPeerDeliveryBookkeeping,
  createPeerOutboxRedelivery,
  derivePeerOutboxStates,
  PEER_OUTBOX_BOOKKEEPING_REPAIR_WINDOW_MS,
  runPeerOutboxRedeliveryPass,
  summarizePeerOutbox,
} from './peer-outbox-redelivery.js';

const SECRET = 'peer-outbox-redelivery-secret';
// Own tenant and peer ids: other peer tests run concurrently on the same runtime root.
const TENANT = 'tenant-peer-outbox-test';
const SENDER = 'outbox-a-test';
const RECIPIENT = 'outbox-b-test';
const DESTINATION = 'http://127.0.0.1:4599';
const CATALOG_PATH = pathResolver.sharedTmp('peer-outbox-redelivery-catalog.test.json');
const T0 = Date.parse('2026-11-12T00:00:00.000Z');

const CATALOG: PeerNetworkCatalog = {
  version: '1',
  tenant_id: TENANT,
  peers: [
    { peer_id: RECIPIENT, base_url: DESTINATION, shared_secret: SECRET, exposure: 'same_host' },
  ],
};

function envelopeFor(messageId: string, ttlMs?: number): PeerMessageEnvelope {
  return buildPeerMessageEnvelope({
    tenantId: TENANT,
    senderPeerId: SENDER,
    recipientPeerId: RECIPIENT,
    messageId,
    subject: 'status_request',
    type: 'request',
    payload: { ask: messageId },
    sharedSecret: SECRET,
    ...(ttlMs ? { ttlMs } : {}),
  });
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const accepted = (messageId: string) =>
  jsonResponse(200, { ok: true, accepted: true, message_id: messageId });

/** The original send; its failure is the starting point of every scenario. */
async function send(envelope: PeerMessageEnvelope) {
  return sendPeerMessage(envelope, { destinationUrl: DESTINATION, allowLocalNetwork: true }).catch(
    (error: Error) => error
  );
}

const pass = (overrides: Partial<Parameters<typeof runPeerOutboxRedeliveryPass>[0]> = {}) =>
  runPeerOutboxRedeliveryPass({ tenantId: TENANT, peerId: SENDER, catalog: CATALOG, ...overrides });

const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

const outboxRows = () => listPeerOutboxRecords(TENANT, SENDER) as Array<Record<string, any>>;

const sentBodies = (fetchSpy: { mock: { calls: unknown[][] } }) =>
  fetchSpy.mock.calls.map((call) => String((call[1] as RequestInit).body));

describe('peer outbox redelivery', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn<typeof globalThis, 'fetch'>>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.useRealTimers();
    clearPeerRuntime(TENANT, SENDER);
    clearPeerRuntime(TENANT, RECIPIENT);
  });

  it('classifies failed attempts as retryable or terminal', () => {
    expect(classifyPeerDeliveryFailure({})).toEqual({
      disposition: 'retryable',
      reason: 'transport_error',
    });
    expect(
      classifyPeerDeliveryFailure({
        httpStatus: 503,
        response: { error: 'receiver_overloaded', retryable: true, retry_after_ms: 1000 },
      })
    ).toEqual({ disposition: 'retryable', reason: 'receiver_retryable', retry_after_ms: 1000 });
    expect(classifyPeerDeliveryFailure({ httpStatus: 429, retryAfterMs: 20_000 })).toEqual({
      disposition: 'retryable',
      reason: 'http_429',
      retry_after_ms: 20_000,
    });
    for (const status of [408, 425, 429, 502, 503, 504]) {
      expect(classifyPeerDeliveryFailure({ httpStatus: status })).toEqual({
        disposition: 'retryable',
        reason: `http_${status}`,
      });
    }
    // A responder that threw may have run partway: never re-sent automatically.
    for (const status of [500, 501, 507]) {
      expect(
        classifyPeerDeliveryFailure({ httpStatus: status, response: { error_code: 'internal' } })
      ).toEqual({ disposition: 'terminal', reason: 'receiver_error' });
    }
    for (const [status, error] of [
      [400, 'invalid_envelope'],
      [401, 'invalid_signature'],
      [403, 'tenant_mismatch'],
      [410, 'envelope_expired'],
      [413, 'request_body_too_large'],
    ] as const) {
      expect(classifyPeerDeliveryFailure({ httpStatus: status, response: { error } })).toEqual({
        disposition: 'terminal',
        reason: `http_${status}`,
      });
    }
    expect(
      classifyPeerDeliveryFailure({ httpStatus: 503, response: { retryable: false } })
    ).toEqual({ disposition: 'terminal', reason: 'receiver_refused' });
  });

  it('never re-sends a receiver error (5xx without a retry signal)', async () => {
    const envelope = envelopeFor('PM-RECEIVER-ERROR');
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(500, { ok: false, error: 'An internal error occurred.', error_code: 'internal' })
    );
    await send(envelope);
    advance(600_000);
    expect(await pass()).toMatchObject({ delivered: [], given_up: [], waiting: 0 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(outboxRows()).toHaveLength(1);
    expect(summarizePeerOutbox(TENANT, SENDER).undelivered).toEqual([
      expect.objectContaining({ state: 'refused', reason: 'receiver_error' }),
    ]);
  });

  it('never re-sends rows written before attempts were classified', async () => {
    // The outbox as an earlier version wrote it: no disposition, no http_status.
    const legacyPath = peerRuntimeLogicalPath(TENANT, SENDER, 'outbox.jsonl');
    for (const [messageId, extra] of [
      ['PM-LEGACY-TRANSPORT', { response: null, error: 'fetch failed' }],
      [
        'PM-LEGACY-OVERLOAD',
        { response: { ok: false, error: 'receiver_overloaded', retryable: true } },
      ],
    ] as const) {
      appendGovernedArtifactJsonl('surface_runtime', legacyPath, {
        sent_at: new Date(T0).toISOString(),
        destination_url: DESTINATION,
        status: 'failed',
        envelope: envelopeFor(messageId),
        ...extra,
      });
    }
    advance(10_000);
    fetchSpy.mockResolvedValue(accepted('unused'));
    const result = await pass();
    expect(result).toMatchObject({ delivered: [], given_up: [], retry_scheduled: [], waiting: 0 });
    await createPeerOutboxRedelivery({
      tenantId: TENANT,
      peerId: SENDER,
      catalog: CATALOG,
    }).runOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(outboxRows()).toHaveLength(2);
    const summary = summarizePeerOutbox(TENANT, SENDER);
    expect(summary.counts).toMatchObject({ legacy_failed: 2, retrying: 0, given_up: 0 });
    expect(summary.undelivered.map((entry) => [entry.state, entry.reason])).toEqual([
      ['legacy_failed', 'legacy_not_retried'],
      ['legacy_failed', 'legacy_not_retried'],
    ]);
  });

  it('skips a message whose caller manages its own delivery retries', async () => {
    const envelope = envelopeFor('PM-CALLER-MANAGED');
    fetchSpy.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    await sendPeerMessage(envelope, {
      destinationUrl: DESTINATION,
      allowLocalNetwork: true,
      recovery: 'caller',
    }).catch(() => undefined);
    expect(outboxRows()[0]).toMatchObject({ disposition: 'retryable', recovery: 'caller' });

    advance(600_000);
    expect(await pass()).toMatchObject({ delivered: [], given_up: [], waiting: 0 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(outboxRows()).toHaveLength(1);
    expect(summarizePeerOutbox(TENANT, SENDER).undelivered).toEqual([
      expect.objectContaining({ state: 'caller_managed', reason: 'transport_error' }),
    ]);
  });

  it('marks auto-reply deliveries as caller-managed', async () => {
    safeWriteFile(CATALOG_PATH, JSON.stringify(CATALOG));
    try {
      fetchSpy.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
      await expect(
        deliverPeerAutoReply(
          {
            tenantId: TENANT,
            localPeerId: SENDER,
            recipientPeerId: RECIPIENT,
            sessionId: 'PCS-OUTBOX-AUTO-REPLY',
            topic: 'outbox',
            text: 'auto reply',
            replyToMessageId: 'PCM-INBOUND-1',
            messageId: 'PCM-AR-OUTBOX-1',
            metadata: { auto_generated: true, auto_turn: 1 },
          },
          { catalogPath: CATALOG_PATH }
        )
      ).rejects.toThrow();
      expect(outboxRows()[0]).toMatchObject({ status: 'failed', recovery: 'caller' });
      advance(600_000);
      await pass();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      safeRmSync(CATALOG_PATH, { force: true });
      clearPeerConversationRuntime(TENANT, SENDER);
    }
  });

  it('records the reply of a redelivered conversation message in the sender transcript, once', async () => {
    safeWriteFile(CATALOG_PATH, JSON.stringify(CATALOG));
    const receiver = createPeerMessagingServer({
      peerId: RECIPIENT,
      tenantId: TENANT,
      sharedSecret: SECRET,
      responder: createPeerConversationResponder({ peerId: RECIPIENT, tenantId: TENANT }),
    });
    const route = async (_url: unknown, init?: RequestInit) => {
      const result = await receiver.processEnvelope(JSON.parse(String(init?.body)));
      return jsonResponse(result.status, result.body);
    };
    const inbound = () =>
      loadPeerConversationSession(TENANT, SENDER, 'PCS-OUTBOX-REDELIVERY')!.transcript.filter(
        (entry) => entry.direction === 'inbound'
      );
    try {
      fetchSpy.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
      await expect(
        sendPeerConversationMessageToPeer({
          tenantId: TENANT,
          senderPeerId: SENDER,
          recipientPeerId: RECIPIENT,
          sessionId: 'PCS-OUTBOX-REDELIVERY',
          topic: 'outbox',
          text: 'are you there?',
          catalogPath: CATALOG_PATH,
        })
      ).rejects.toThrow();
      expect(inbound()).toEqual([]);

      advance(5_000);
      fetchSpy.mockImplementation(route as typeof fetch);
      const delivered = await pass();
      expect(delivered.delivered).toHaveLength(1);
      expect(delivered.bookkeeping_failed).toEqual([]);
      // Same transcript as a first-try delivery: the receiver's reply is recorded.
      expect(inbound().map((entry) => entry.text)).toEqual([
        `Received by ${RECIPIENT}: are you there?`,
      ]);

      // Crash repair: a later pass replays the bookkeeping from the outbox row. Idempotent.
      const onDelivered = vi.fn(applyPeerDeliveryBookkeeping);
      await pass({ onDelivered });
      expect(onDelivered).toHaveBeenCalledTimes(1);
      expect(inbound()).toHaveLength(1);
      // Outside the repair window nothing is replayed.
      advance(PEER_OUTBOX_BOOKKEEPING_REPAIR_WINDOW_MS);
      await pass({ onDelivered });
      expect(onDelivered).toHaveBeenCalledTimes(1);
    } finally {
      safeRmSync(CATALOG_PATH, { force: true });
      clearPeerConversationRuntime(TENANT, SENDER);
      clearPeerConversationRuntime(TENANT, RECIPIENT);
    }
  });

  it('reports a failed bookkeeping and replays it on the next pass', async () => {
    const envelope = envelopeFor('PM-BOOKKEEPING-RETRY');
    fetchSpy.mockRejectedValueOnce(new Error('timeout'));
    await send(envelope);
    advance(5_000);
    fetchSpy.mockResolvedValueOnce(accepted(envelope.message_id));
    const onDelivered = vi.fn().mockRejectedValueOnce(new Error('session store unavailable'));
    const first = await pass({ onDelivered });
    expect(first).toMatchObject({
      delivered: [envelope.message_id],
      bookkeeping_failed: [envelope.message_id],
    });
    const second = await pass({ onDelivered });
    expect(second.bookkeeping_failed).toEqual([]);
    expect(onDelivered).toHaveBeenCalledTimes(2);
    expect(onDelivered.mock.calls[1][0]).toMatchObject({
      envelope: { message_id: envelope.message_id },
      duplicate: false,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('re-sends a retryable failure with the original envelope once the backoff has passed', async () => {
    const envelope = envelopeFor('PM-RETRY-THEN-OK');
    fetchSpy.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    await send(envelope);
    expect(derivePeerOutboxStates(TENANT, SENDER).get(envelope.message_id)).toMatchObject({
      state: 'retrying',
      attempts: 1,
      reason: 'transport_error',
    });

    // Not due yet: nothing is sent.
    advance(4_999);
    const early = await pass();
    expect(early).toMatchObject({ status: 'completed', delivered: [], waiting: 1 });
    expect(early.next_attempt_at).toBe(new Date(T0 + 5_000).toISOString());
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    advance(1);
    fetchSpy.mockResolvedValueOnce(accepted(envelope.message_id));
    const due = await pass();
    expect(due.delivered).toEqual([envelope.message_id]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // Same message id and signature: byte-identical body.
    const [first, second] = sentBodies(fetchSpy);
    expect(second).toBe(first);
    expect(JSON.parse(second).signature).toBe(envelope.signature);

    expect(outboxRows().map((row) => [row.status, row.redelivery ?? false])).toEqual([
      ['failed', false],
      ['sent', true],
    ]);
    expect(summarizePeerOutbox(TENANT, SENDER).counts).toEqual({
      delivered: 1,
      refused: 0,
      given_up: 0,
      retrying: 0,
      caller_managed: 0,
      legacy_failed: 0,
    });
    // Delivered is settled: a later pass sends nothing.
    advance(60_000);
    expect((await pass()).delivered).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('waits for retry_after_ms when the receiver asks for longer than the backoff', async () => {
    const envelope = envelopeFor('PM-RETRY-AFTER');
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(503, {
        ok: false,
        error: 'receiver_overloaded',
        retryable: true,
        retry_after_ms: 30_000,
      })
    );
    const receipt = await send(envelope);
    expect(receipt).toMatchObject({
      ok: false,
      failure: { disposition: 'retryable', retry_after_ms: 30_000 },
    });
    expect(outboxRows()[0]).toMatchObject({
      status: 'failed',
      http_status: 503,
      disposition: 'retryable',
      reason: 'receiver_retryable',
      retry_after_ms: 30_000,
    });

    advance(29_999); // well past the 5 s backoff
    const early = await pass();
    expect(early.waiting).toBe(1);
    expect(early.next_attempt_at).toBe(new Date(T0 + 30_000).toISOString());
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    advance(1);
    fetchSpy.mockResolvedValueOnce(accepted(envelope.message_id));
    expect((await pass()).delivered).toEqual([envelope.message_id]);
  });

  it('honours a Retry-After header when the body carries no delay', async () => {
    const envelope = envelopeFor('PM-RETRY-AFTER-HEADER');
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(429, { ok: false, error: 'slow_down' }, { 'Retry-After': '20' })
    );
    await send(envelope);
    advance(19_999);
    expect((await pass()).waiting).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('gives up with a recorded reason once the attempts are exhausted', async () => {
    const envelope = envelopeFor('PM-EXHAUSTED');
    const policy = { maxAttempts: 3, baseBackoffMs: 1_000 };
    fetchSpy.mockRejectedValue(new Error('connect ECONNREFUSED'));
    await send(envelope);

    advance(1_000);
    expect(await pass({ policy })).toMatchObject({ retry_scheduled: [envelope.message_id] });
    advance(1_999); // second backoff is 2 s
    expect((await pass({ policy })).waiting).toBe(1);
    advance(1);
    const last = await pass({ policy });
    expect(last.given_up).toEqual([
      { message_id: envelope.message_id, reason: 'attempts_exhausted' },
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    expect(outboxRows().map((row) => row.status)).toEqual([
      'failed',
      'failed',
      'failed',
      'given_up',
    ]);
    expect(outboxRows()[3]).toMatchObject({
      reason: 'attempts_exhausted',
      attempts: 3,
      error: 'connect ECONNREFUSED',
    });
    // Terminal: never sent again, and visible to the operator.
    advance(3_600_000);
    await pass({ policy });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(summarizePeerOutbox(TENANT, SENDER).undelivered).toEqual([
      expect.objectContaining({
        message_id: envelope.message_id,
        state: 'given_up',
        reason: 'attempts_exhausted',
        attempts: 3,
      }),
    ]);
  });

  it('gives up an expired envelope without sending it', async () => {
    const expiring = envelopeFor('PM-EXPIRED', 10_000);
    const untimed = envelopeFor('PM-NO-TTL');
    fetchSpy.mockRejectedValue(new Error('timeout'));
    await send(expiring);
    await send(untimed);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    advance(10_000);
    fetchSpy.mockResolvedValue(accepted(untimed.message_id));
    const first = await pass({ policy: { retryWindowMs: 60_000 } });
    expect(first.given_up).toEqual([
      { message_id: expiring.message_id, reason: 'envelope_expired' },
    ]);
    expect(first.delivered).toEqual([untimed.message_id]);
    expect(sentBodies(fetchSpy).filter((body) => body.includes('PM-EXPIRED'))).toHaveLength(1);
  });

  it('gives up an envelope without expiry once the retry window has elapsed', async () => {
    const envelope = envelopeFor('PM-WINDOW');
    fetchSpy.mockRejectedValueOnce(new Error('timeout'));
    await send(envelope);
    advance(60_000);
    const result = await pass({ policy: { retryWindowMs: 60_000 } });
    expect(result.given_up).toEqual([
      { message_id: envelope.message_id, reason: 'retry_window_elapsed' },
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('never retries a terminal refusal', async () => {
    const envelope = envelopeFor('PM-REFUSED');
    fetchSpy.mockResolvedValueOnce(jsonResponse(401, { ok: false, error: 'invalid_signature' }));
    await send(envelope);
    expect(outboxRows()[0]).toMatchObject({
      status: 'failed',
      http_status: 401,
      disposition: 'terminal',
      reason: 'http_401',
    });

    advance(600_000);
    const result = await pass();
    expect(result).toMatchObject({ delivered: [], given_up: [], retry_scheduled: [], waiting: 0 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(outboxRows()).toHaveLength(1);
    expect(summarizePeerOutbox(TENANT, SENDER).undelivered).toEqual([
      expect.objectContaining({
        message_id: envelope.message_id,
        state: 'refused',
        reason: 'http_401',
        last_error: 'invalid_signature',
      }),
    ]);
  });

  it('records a refusal met during redelivery and stops', async () => {
    const envelope = envelopeFor('PM-REFUSED-LATER');
    fetchSpy.mockRejectedValueOnce(new Error('timeout'));
    await send(envelope);
    advance(5_000);
    fetchSpy.mockResolvedValueOnce(jsonResponse(403, { ok: false, error: 'tenant_mismatch' }));
    expect((await pass()).refused).toEqual([
      { message_id: envelope.message_id, reason: 'http_403' },
    ]);
    advance(600_000);
    await pass();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('gives up when the recipient is no longer enrolled in the peer catalog', async () => {
    const envelope = envelopeFor('PM-UNENROLLED');
    fetchSpy.mockRejectedValueOnce(new Error('timeout'));
    await send(envelope);
    advance(5_000);
    const result = await pass({ catalog: { ...CATALOG, peers: [] } });
    expect(result.given_up).toEqual([
      { message_id: envelope.message_id, reason: 'peer_not_enrolled' },
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('is deduplicated by the receiver when the first attempt was processed but its receipt was lost', async () => {
    const responder = vi.fn(async () => ({ handled: true }));
    const receiver = createPeerMessagingServer({
      peerId: RECIPIENT,
      tenantId: TENANT,
      sharedSecret: SECRET,
      responder,
    });
    const deliver = async (init?: RequestInit) => {
      const result = await receiver.processEnvelope(JSON.parse(String(init?.body)));
      return jsonResponse(result.status, result.body);
    };
    const envelope = envelopeFor('PM-DUPLICATE');
    // The receiver processes the message; the sender never sees the receipt.
    fetchSpy.mockImplementationOnce(async (_url, init) => {
      await deliver(init);
      throw new Error('socket hang up');
    });
    await send(envelope);
    expect(responder).toHaveBeenCalledTimes(1);

    advance(5_000);
    fetchSpy.mockImplementationOnce(async (_url, init) => deliver(init));
    expect((await pass()).delivered).toEqual([envelope.message_id]);

    expect(responder).toHaveBeenCalledTimes(1);
    expect(listPeerInboxRecords(TENANT, RECIPIENT)).toHaveLength(1);
    expect(outboxRows()[1]).toMatchObject({
      status: 'sent',
      redelivery: true,
      response: { duplicate: true },
    });
  });

  it('does not double-send when two passes run concurrently', async () => {
    const envelope = envelopeFor('PM-CONCURRENT');
    fetchSpy.mockRejectedValueOnce(new Error('timeout'));
    await send(envelope);
    advance(5_000);

    let release!: (response: Response) => void;
    fetchSpy.mockImplementationOnce(() => new Promise<Response>((resolve) => (release = resolve)));
    const first = pass();
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    // A second process (CLI or server) starts a pass while the first is sending.
    const second = await pass();
    expect(second).toMatchObject({ status: 'skipped', reason: 'pass_in_progress', delivered: [] });

    release(accepted(envelope.message_id));
    expect((await first).delivered).toEqual([envelope.message_id]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // The lock is released: the next pass runs (and finds nothing to do).
    expect((await pass()).status).toBe('completed');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('continues from the ledger after a restart', async () => {
    const envelope = envelopeFor('PM-RESTART');
    const config = {
      tenantId: TENANT,
      peerId: SENDER,
      catalog: CATALOG,
      policy: { maxAttempts: 3, baseBackoffMs: 1_000 },
    };
    fetchSpy.mockRejectedValue(new Error('connect ECONNREFUSED'));
    await send(envelope);

    advance(1_000);
    const beforeRestart = createPeerOutboxRedelivery(config);
    expect((await beforeRestart.runOnce()).retry_scheduled).toEqual([envelope.message_id]);
    // The same worker reads only the appended rows and keeps the attempt count.
    expect((await beforeRestart.runOnce()).waiting).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // A new process has no memory: attempts and backoff come from the outbox rows.
    const afterRestart = createPeerOutboxRedelivery(config);
    advance(1_999);
    expect((await afterRestart.runOnce()).waiting).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    advance(1);
    expect((await afterRestart.runOnce()).given_up).toEqual([
      { message_id: envelope.message_id, reason: 'attempts_exhausted' },
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    advance(60_000);
    await afterRestart.runOnce();
    await createPeerOutboxRedelivery(config).runOnce();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('runs passes on a timer while started and sends nothing after stop', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const first = envelopeFor('PM-LOOP-1');
    const second = envelopeFor('PM-LOOP-2');
    fetchSpy.mockRejectedValueOnce(new Error('timeout'));
    await send(first);

    const worker = createPeerOutboxRedelivery({
      tenantId: TENANT,
      peerId: SENDER,
      catalog: CATALOG,
      intervalMs: 1_000,
    });
    worker.start();
    fetchSpy.mockResolvedValueOnce(accepted(first.message_id));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(derivePeerOutboxStates(TENANT, SENDER).get(first.message_id)?.state).toBe('delivered');

    await worker.stop();
    fetchSpy.mockRejectedValueOnce(new Error('timeout'));
    await send(second);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(derivePeerOutboxStates(TENANT, SENDER).get(second.message_id)?.state).toBe('retrying');
  });
});
