/**
 * Delivery recovery for the peer-messaging outbox.
 *
 * `sendPeerMessage` records every attempt as an outbox row. This module
 * derives each message's delivery state from those rows (nothing is
 * rewritten, there is no second ledger) and re-sends retryable failures with
 * the envelope that was originally signed, so the receiver either processes
 * it once or answers `duplicate` (it dedupes on sender:message_id).
 *
 * State of a message = fold of its rows, oldest first:
 *   sent                           -> delivered
 *   failed + terminal              -> refused
 *   failed + retryable             -> retrying (attempts counted from the rows)
 *   failed + retryable + recovery  -> caller_managed (the caller retries; never re-sent here)
 *   failed without `disposition`   -> legacy_failed (written before redelivery; never re-sent)
 *   given_up                       -> given_up (attempts exhausted, expired, ...)
 *
 * A redelivered message gets the same sender-side bookkeeping as a first-try
 * delivery (conversation reply into the transcript, peer task delivery state)
 * through `onDelivered`. That bookkeeping is idempotent and is replayed from
 * every `sent` row (first-try or redelivered) on later passes for a while, so
 * a crash or error between the `sent` row and the bookkeeping is repaired.
 *
 * A pass holds a per-(tenant, peer) inter-process lock, so the CLI and the
 * conversation server never run two passes over one outbox. It only ever
 * re-sends a message some caller already sent: it selects no peer and
 * creates no work.
 */
import * as path from 'node:path';

import { createLogger } from '../logger.js';
import { acquireLock, releaseLock } from '../foundation/lock-utils.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeReaddir, validateUrl } from '../secure-io.js';
import { isRecord } from '../foundation/text.js';
import { createJsonlTail, type JsonlTail } from '../storage/jsonl-tail.js';
import { applyPeerConversationDelivery, loadTenantPeerCatalog } from './peer-conversation.js';
import { applyPeerTaskDelivery } from './peer-task-exchange.js';
import {
  boundedPeerRetryAfterMs,
  classifyPeerDeliveryFailure,
  parsePeerOutboxRecord,
  peerRuntimeLogicalPath,
  recordPeerOutboxGiveUp,
  resolvePeerDispatchTarget,
  sendPeerMessage,
  streamPeerOutboxRecords,
  type PeerMessageEnvelope,
  type PeerNetworkCatalog,
  type PeerOutboxDelivery,
  type PeerOutboxRecord,
} from './peer-messaging.js';

const log = createLogger('peer-outbox-redelivery');
/** One warning per message per process for a failing bookkeeping replay. */
const bookkeepingWarned = new Set<string>();
/** Outboxes (`tenant/peer`) whose catalog could not be loaded; warned once until it loads again. */
const catalogUnavailable = new Set<string>();

export interface PeerOutboxRedeliveryPolicy {
  /** Delivery attempts per message, counting the original send. */
  maxAttempts: number;
  /** Wait after the first failure; doubles per further failure. */
  baseBackoffMs: number;
  maxBackoffMs: number;
  /** Envelopes without `expires_at` stop being re-sent this long after `created_at`. */
  retryWindowMs: number;
}

export const DEFAULT_PEER_OUTBOX_REDELIVERY_POLICY: Readonly<PeerOutboxRedeliveryPolicy> =
  Object.freeze({
    maxAttempts: 8,
    baseBackoffMs: 5_000,
    maxBackoffMs: 5 * 60_000,
    retryWindowMs: 60 * 60_000,
  });

/** How long after a redelivered `sent` row its bookkeeping is replayed on later passes. */
export const PEER_OUTBOX_BOOKKEEPING_REPAIR_WINDOW_MS = 24 * 60 * 60_000;

export type PeerOutboxDeliveryState =
  | 'delivered'
  | 'refused'
  /** A 2xx answer the sender could not read: the receiver may have handled the message. */
  | 'unconfirmed'
  | 'given_up'
  | 'retrying'
  | 'caller_managed'
  | 'legacy_failed';

/**
 * Sender-side bookkeeping of a delivered message, as the owning layers apply
 * it on a first-try delivery: the conversation transcript, then the peer task
 * record. Idempotent.
 */
export async function applyPeerDeliveryBookkeeping(delivery: PeerOutboxDelivery): Promise<void> {
  // A reply the transcript cannot take must not keep the task record from
  // being settled: both run, and the first failure is reported afterwards.
  let transcriptError: unknown;
  try {
    applyPeerConversationDelivery(delivery);
  } catch (error) {
    transcriptError = error;
  }
  await applyPeerTaskDelivery(delivery);
  if (transcriptError) throw transcriptError;
}

export interface PeerOutboxMessageState {
  message_id: string;
  recipient_peer_id: string;
  subject: string;
  state: PeerOutboxDeliveryState;
  /** Attempts since the message last left a settled state. */
  attempts: number;
  /** Classification of the last failure, or why redelivery stopped. */
  reason?: string;
  last_error?: string;
  /** Time of the row that set this state. */
  updated_at: string;
  created_at: string;
  expires_at?: string;
  retry_after_ms?: number;
  /** Only while `retrying`: what the next attempt re-sends, and where it last went. */
  envelope?: PeerMessageEnvelope;
  destination_url?: string;
  /** Only while `delivered`: the input of the sender-side bookkeeping replay. */
  redelivered?: PeerOutboxDelivery;
}

export type PeerOutboxGiveUpReason =
  | 'attempts_exhausted'
  | 'envelope_expired'
  | 'retry_window_elapsed'
  | 'peer_not_enrolled'
  | 'destination_not_allowed';

/** Fold one outbox row into the per-message state map (rows oldest first). */
export function foldPeerOutboxRecord(
  states: Map<string, PeerOutboxMessageState>,
  row: PeerOutboxRecord
): void {
  const envelope = row.envelope;
  const prior = states.get(envelope.message_id);
  const base = {
    message_id: envelope.message_id,
    recipient_peer_id: envelope.recipient_peer_id,
    subject: envelope.subject,
    updated_at: row.sent_at,
    created_at: envelope.created_at,
    ...(envelope.expires_at ? { expires_at: envelope.expires_at } : {}),
  };
  const priorAttempts = prior?.state === 'retrying' ? prior.attempts : 0;
  if (row.status === 'sent') {
    const body = isRecord(row.response) ? row.response : {};
    states.set(envelope.message_id, {
      ...base,
      state: 'delivered',
      attempts: priorAttempts + 1,
      // Kept for the bookkeeping replay: a first-try delivery whose local
      // bookkeeping failed is repaired the same way as a redelivered one.
      redelivered: {
        envelope,
        ...(body.response !== undefined ? { response: body.response } : {}),
        duplicate: body.duplicate === true,
        replayed_from: row.sent_at,
      },
    });
    return;
  }
  if (row.status === 'given_up') {
    states.set(envelope.message_id, {
      ...base,
      state: 'given_up',
      attempts: row.attempts ?? priorAttempts,
      ...(row.reason ? { reason: row.reason } : {}),
      ...(row.error ? { last_error: row.error } : {}),
    });
    return;
  }
  if (!row.disposition) {
    // Written before attempts were classified: the operator may already have
    // re-sent it under a new id, so an upgrade never re-sends it.
    states.set(envelope.message_id, {
      ...base,
      state: 'legacy_failed',
      attempts: priorAttempts + 1,
      reason: 'legacy_not_retried',
      ...(row.error ? { last_error: row.error } : {}),
    });
    return;
  }
  const retryable = row.disposition === 'retryable';
  const retrying = retryable && row.recovery !== 'caller';
  states.set(envelope.message_id, {
    ...base,
    state: retrying
      ? 'retrying'
      : retryable
        ? 'caller_managed'
        : row.reason === 'invalid_response'
          ? 'unconfirmed'
          : 'refused',
    attempts: priorAttempts + 1,
    reason: row.reason || 'unclassified',
    ...(row.error ? { last_error: row.error } : {}),
    // Rows come from disk: the delay is bounded again here.
    ...(retrying && boundedPeerRetryAfterMs(row.retry_after_ms)
      ? { retry_after_ms: boundedPeerRetryAfterMs(row.retry_after_ms) }
      : {}),
    ...(retrying ? { envelope, destination_url: row.destination_url } : {}),
  });
}

/** Current delivery state of every message in a peer's outbox (full read). */
export function derivePeerOutboxStates(
  tenantId: string,
  peerId: string
): Map<string, PeerOutboxMessageState> {
  const states = new Map<string, PeerOutboxMessageState>();
  for (const row of streamPeerOutboxRecords(tenantId, peerId)) foldPeerOutboxRecord(states, row);
  return states;
}

/** ISO time of an epoch value from a row; a hand-edited row must not throw here. */
function toIso(epochMs: number): string {
  return new Date(Math.min(Math.max(epochMs, 0), 8.64e15)).toISOString();
}

function resolvePolicy(policy: Partial<PeerOutboxRedeliveryPolicy> = {}) {
  return { ...DEFAULT_PEER_OUTBOX_REDELIVERY_POLICY, ...policy };
}

/** Earliest time the next attempt of a `retrying` message may start (epoch ms). */
export function peerOutboxNextAttemptAt(
  state: Pick<PeerOutboxMessageState, 'attempts' | 'updated_at' | 'retry_after_ms'>,
  policy: Partial<PeerOutboxRedeliveryPolicy> = {}
): number {
  const { baseBackoffMs, maxBackoffMs } = resolvePolicy(policy);
  const backoff = Math.min(maxBackoffMs, baseBackoffMs * 2 ** Math.max(0, state.attempts - 1));
  const retryAfter = Math.min(boundedPeerRetryAfterMs(state.retry_after_ms) ?? 0, maxBackoffMs);
  return Date.parse(state.updated_at) + Math.max(backoff, retryAfter);
}

export interface PeerOutboxSummary {
  tenant_id: string;
  peer_id: string;
  counts: Record<PeerOutboxDeliveryState, number>;
  /** Messages waiting for another attempt, with the time it is due. */
  retrying: Array<
    Omit<PeerOutboxMessageState, 'envelope' | 'redelivered'> & { next_attempt_at: string }
  >;
  /**
   * Not delivered and not re-sent by the pass: `refused`, `given_up`,
   * `legacy_failed` (failed before redelivery existed) and `caller_managed`
   * (the sending caller retries and records the outcome itself).
   */
  undelivered: Array<Omit<PeerOutboxMessageState, 'envelope' | 'redelivered'>>;
}

/** Local peers of a tenant that have a runtime directory (and so may have an outbox). */
export function listPeerOutboxPeerIds(tenantId: string): string[] {
  // Derived from the runtime path contract (which validates the tenant): the
  // parent of any peer's directory is the tenant's peers directory.
  const peersDir = path.dirname(
    path.dirname(pathResolver.resolve(peerRuntimeLogicalPath(tenantId, 'peer-x', 'outbox.jsonl')))
  );
  if (!safeExistsSync(peersDir)) return [];
  return safeReaddir(peersDir)
    .filter((name) => /^[a-z][a-z0-9-]{1,63}$/u.test(name))
    .sort();
}

/** Operator view of a peer's outbox: counts, pending retries and terminal failures. */
export function summarizePeerOutbox(
  tenantId: string,
  peerId: string,
  policy: Partial<PeerOutboxRedeliveryPolicy> = {}
): PeerOutboxSummary {
  const summary: PeerOutboxSummary = {
    tenant_id: tenantId,
    peer_id: peerId,
    counts: {
      delivered: 0,
      refused: 0,
      unconfirmed: 0,
      given_up: 0,
      retrying: 0,
      caller_managed: 0,
      legacy_failed: 0,
    },
    retrying: [],
    undelivered: [],
  };
  for (const state of derivePeerOutboxStates(tenantId, peerId).values()) {
    summary.counts[state.state] += 1;
    const { envelope: _envelope, redelivered: _redelivered, ...view } = state;
    if (state.state === 'retrying') {
      summary.retrying.push({
        ...view,
        next_attempt_at: toIso(peerOutboxNextAttemptAt(state, policy)),
      });
    } else if (state.state !== 'delivered') {
      summary.undelivered.push(view);
    }
  }
  return summary;
}

/**
 * Incremental view of the `retrying` messages of one outbox: each refresh
 * reads only the rows appended since the previous one, so a long-lived
 * process does not re-read the outbox history on every pass.
 */
class PeerOutboxRetryTracker {
  private readonly tail: JsonlTail<PeerOutboxRecord | null>;
  private readonly states = new Map<string, PeerOutboxMessageState>();

  constructor(tenantId: string, peerId: string) {
    this.tail = createJsonlTail<PeerOutboxRecord | null>(
      pathResolver.resolve(peerRuntimeLogicalPath(tenantId, peerId, 'outbox.jsonl')),
      {
        parse: (value) => {
          try {
            return parsePeerOutboxRecord(value, tenantId, peerId) as unknown as PeerOutboxRecord;
          } catch {
            return null;
          }
        },
      }
    );
  }

  refresh(): Map<string, PeerOutboxMessageState> {
    const batch = this.tail.read();
    if (batch.rotated) this.states.clear();
    for (const row of batch.records) if (row) foldPeerOutboxRecord(this.states, row);
    // Only messages with work left stay in memory: pending retries, and
    // redelivered ones until their bookkeeping is confirmed (see `settle`).
    for (const [messageId, state] of this.states) {
      if (state.state !== 'retrying' && !state.redelivered) this.states.delete(messageId);
    }
    return this.states;
  }

  /** The bookkeeping of a redelivered message was applied in this process. */
  settle(messageId: string): void {
    if (this.states.get(messageId)?.state === 'delivered') this.states.delete(messageId);
  }
}

export interface PeerOutboxRedeliveryPassOptions {
  tenantId: string;
  peerId: string;
  policy?: Partial<PeerOutboxRedeliveryPolicy>;
  /**
   * Peer catalog override (tests). Production always reads the tenant's own
   * catalog file (never an explicit path or the KYBERION_PEER_NETWORK_CATALOG
   * override): a send that resolved through any other catalog is recorded
   * caller-managed and is never re-sent here.
   */
  catalog?: PeerNetworkCatalog | null;
  /** Per-attempt HTTP timeout. */
  timeoutMs?: number;
  now?: () => number;
  /** Checked between messages; a true result ends the pass early. */
  shouldStop?: () => boolean;
  /**
   * Sender-side bookkeeping of a redelivered message; must be idempotent.
   * Default: {@link applyPeerDeliveryBookkeeping}.
   */
  onDelivered?: (delivery: PeerOutboxDelivery) => Promise<void> | void;
}

export interface PeerOutboxRedeliveryPassResult {
  status: 'completed' | 'skipped';
  /** Why the pass did nothing (`pass_in_progress`). */
  reason?: string;
  delivered: string[];
  refused: Array<{ message_id: string; reason: string }>;
  given_up: Array<{ message_id: string; reason: PeerOutboxGiveUpReason }>;
  /** Failed again with a retryable error; another attempt is scheduled. */
  retry_scheduled: string[];
  /** Delivered, but the sender-side bookkeeping failed; it is replayed on a later pass. */
  bookkeeping_failed: string[];
  /** Still `retrying` and not yet due (or blocked by an unreadable catalog). */
  waiting: number;
  /** Earliest due time among the messages still `retrying`. */
  next_attempt_at?: string;
}

function redeliveryLockId(tenantId: string, peerId: string): string {
  // '/' and ':' are outside the tenant and peer slug alphabets, so two
  // (tenant, peer) pairs can never spell the same lock id.
  return `peer-outbox-redelivery:${tenantId}/${peerId}`;
}

async function runPass(
  options: PeerOutboxRedeliveryPassOptions,
  loadStates: () => Map<string, PeerOutboxMessageState>,
  onSettled: (messageId: string) => void = () => undefined
): Promise<PeerOutboxRedeliveryPassResult> {
  const { tenantId, peerId } = options;
  const policy = resolvePolicy(options.policy);
  const now = options.now ?? Date.now;
  const result: PeerOutboxRedeliveryPassResult = {
    status: 'completed',
    delivered: [],
    refused: [],
    given_up: [],
    retry_scheduled: [],
    bookkeeping_failed: [],
    waiting: 0,
  };
  const lockId = redeliveryLockId(tenantId, peerId);
  // Non-blocking: another pass over this outbox is already doing the work.
  if (!(await acquireLock(lockId, 0))) {
    return { ...result, status: 'skipped', reason: 'pass_in_progress' };
  }
  try {
    let nextAttemptAt = Number.POSITIVE_INFINITY;
    const stillRetrying = (state: PeerOutboxMessageState) => {
      result.waiting += 1;
      nextAttemptAt = Math.min(nextAttemptAt, peerOutboxNextAttemptAt(state, policy));
    };
    const giveUp = (
      state: PeerOutboxMessageState,
      reason: PeerOutboxGiveUpReason,
      lastError = state.last_error
    ) => {
      recordPeerOutboxGiveUp({
        envelope: state.envelope!,
        destinationUrl: state.destination_url!,
        reason,
        attempts: state.attempts,
        ...(lastError ? { lastError } : {}),
      });
      result.given_up.push({ message_id: state.message_id, reason });
      log.warn(
        `gave up delivering ${state.message_id} to ${state.recipient_peer_id} — ${reason}${lastError ? ` (${lastError})` : ''} | next: resend it once the cause is fixed | attempts=${state.attempts} peer=${peerId} tenant=${tenantId}`
      );
    };
    let catalog: PeerNetworkCatalog | null | undefined = options.catalog;
    const outboxKey = `${tenantId}/${peerId}`;
    const loadCatalog = () => {
      if (catalog === undefined) {
        catalog = loadTenantPeerCatalog(tenantId);
      }
      if (catalog) catalogUnavailable.delete(outboxKey);
      return catalog;
    };

    const onDelivered = options.onDelivered ?? applyPeerDeliveryBookkeeping;
    const bookkeep = async (delivery: PeerOutboxDelivery): Promise<void> => {
      const messageId = delivery.envelope.message_id;
      try {
        await onDelivered(delivery);
        bookkeepingWarned.delete(messageId);
        onSettled(messageId);
      } catch (error) {
        result.bookkeeping_failed.push(messageId);
        if (!bookkeepingWarned.has(messageId)) {
          bookkeepingWarned.add(messageId);
          log.warn(
            `${messageId} was delivered but its sender-side bookkeeping failed — ${error instanceof Error ? error.message : String(error)} | next: it is replayed on later passes; check the conversation session or peer task record | peer=${peerId} tenant=${tenantId}`
          );
        }
      }
    };

    const states = Array.from(loadStates().values());
    // Repair: a redelivery whose bookkeeping may not have run (crash after the
    // `sent` row) is replayed from the row; the bookkeeping is idempotent.
    for (const state of states) {
      if (options.shouldStop?.()) break;
      if (state.state !== 'delivered' || !state.redelivered) continue;
      if (Date.parse(state.updated_at) + PEER_OUTBOX_BOOKKEEPING_REPAIR_WINDOW_MS <= now()) {
        bookkeepingWarned.delete(state.message_id);
        onSettled(state.message_id);
        continue;
      }
      await bookkeep(state.redelivered);
    }
    const pending = states.filter(
      (state) => state.state === 'retrying' && state.envelope && state.destination_url
    );
    for (const state of pending) {
      if (options.shouldStop?.()) {
        stillRetrying(state);
        continue;
      }
      const at = now();
      if (state.expires_at && Date.parse(state.expires_at) <= at) {
        giveUp(state, 'envelope_expired');
        continue;
      }
      if (!state.expires_at && Date.parse(state.created_at) + policy.retryWindowMs <= at) {
        giveUp(state, 'retry_window_elapsed');
        continue;
      }
      if (state.attempts >= policy.maxAttempts) {
        giveUp(state, 'attempts_exhausted');
        continue;
      }
      if (at < peerOutboxNextAttemptAt(state, policy)) {
        stillRetrying(state);
        continue;
      }
      const peers = loadCatalog();
      if (!peers) {
        if (!catalogUnavailable.has(outboxKey)) {
          catalogUnavailable.add(outboxKey);
          log.warn(
            `redelivery paused — peer catalog for tenant ${tenantId} could not be loaded | next: check the tenant peer catalog; retries resume on a later pass | peer=${peerId}`
          );
        }
        stillRetrying(state);
        continue;
      }
      let target: ReturnType<typeof resolvePeerDispatchTarget>;
      try {
        target = resolvePeerDispatchTarget(state.recipient_peer_id, peers);
      } catch (error) {
        giveUp(state, 'peer_not_enrolled', error instanceof Error ? error.message : String(error));
        continue;
      }
      try {
        validateUrl(target.destinationUrl, { allowLocalNetwork: target.allowLocalNetwork });
      } catch (error) {
        giveUp(
          state,
          'destination_not_allowed',
          error instanceof Error ? error.message : String(error)
        );
        continue;
      }

      // The envelope is re-sent exactly as signed: same message id, same signature.
      let failure: { state: PeerOutboxDeliveryState; reason: string; error?: string };
      let retryAfterMs: number | undefined;
      try {
        const receipt = await sendPeerMessage(state.envelope!, {
          destinationUrl: target.destinationUrl,
          allowLocalNetwork: target.allowLocalNetwork,
          redelivery: true,
          ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        });
        if (receipt.ok) {
          result.delivered.push(state.message_id);
          await bookkeep({
            envelope: state.envelope!,
            ...(receipt.response !== undefined ? { response: receipt.response } : {}),
            duplicate: receipt.duplicate === true,
          });
          continue;
        }
        const classified =
          receipt.failure ?? classifyPeerDeliveryFailure({ httpStatus: receipt.status });
        failure = {
          state: classified.disposition === 'retryable' ? 'retrying' : 'refused',
          reason: classified.reason,
          ...(receipt.error ? { error: receipt.error } : {}),
        };
        retryAfterMs = classified.retry_after_ms;
      } catch (error) {
        failure = {
          state: 'retrying',
          reason: 'transport_error',
          error: error instanceof Error ? error.message : String(error),
        };
      }
      if (failure.state === 'refused') {
        result.refused.push({ message_id: state.message_id, reason: failure.reason });
        log.warn(
          `peer ${state.recipient_peer_id} refused ${state.message_id} — ${failure.error || failure.reason} | next: fix the cause and send a new message; it is not retried | peer=${peerId} tenant=${tenantId}`
        );
        continue;
      }
      const after: PeerOutboxMessageState = {
        ...state,
        attempts: state.attempts + 1,
        reason: failure.reason,
        updated_at: new Date(now()).toISOString(),
        ...(failure.error ? { last_error: failure.error } : {}),
        retry_after_ms: boundedPeerRetryAfterMs(retryAfterMs),
      };
      if (after.attempts >= policy.maxAttempts) {
        giveUp(after, 'attempts_exhausted');
        continue;
      }
      result.retry_scheduled.push(state.message_id);
      stillRetrying(after);
    }
    if (Number.isFinite(nextAttemptAt)) {
      result.next_attempt_at = toIso(nextAttemptAt);
    }
    return result;
  } finally {
    releaseLock(lockId);
  }
}

/**
 * One redelivery pass over a peer's outbox (full read of the outbox): gives
 * up expired and exhausted messages, re-sends the retryable failures that are
 * due, and leaves the rest for a later pass. Returns `skipped` when another
 * pass holds the outbox lock.
 */
export function runPeerOutboxRedeliveryPass(
  options: PeerOutboxRedeliveryPassOptions
): Promise<PeerOutboxRedeliveryPassResult> {
  return runPass(options, () => derivePeerOutboxStates(options.tenantId, options.peerId));
}

export interface PeerOutboxRedeliveryConfig extends Omit<
  PeerOutboxRedeliveryPassOptions,
  'shouldStop'
> {
  /** Delay between passes while started. */
  intervalMs?: number;
}

export interface PeerOutboxRedelivery {
  /** One pass; a call made while a pass runs returns that pass. */
  runOnce(): Promise<PeerOutboxRedeliveryPassResult>;
  start(): void;
  /** Stops the timer and waits for the pass in flight (no send starts afterwards). */
  stop(): Promise<void>;
}

/**
 * Redelivery worker for a long-lived process (the peer conversation server).
 * Passes never overlap (self-rescheduling timer + in-flight guard) and read
 * only the outbox rows appended since the previous pass.
 */
export function createPeerOutboxRedelivery(
  config: PeerOutboxRedeliveryConfig
): PeerOutboxRedelivery {
  const intervalMs = config.intervalMs ?? 5_000;
  if (!Number.isFinite(intervalMs) || intervalMs < 100) {
    // A caller that wants no timer does not call start(); 0 or NaN here would spin.
    throw new Error(`invalid_peer_outbox_redelivery_interval:${String(config.intervalMs)}`);
  }
  const tracker = new PeerOutboxRetryTracker(config.tenantId, config.peerId);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<PeerOutboxRedeliveryPassResult> | undefined;
  let stopped = true;
  let stopRequested = false;

  const runOnce = (): Promise<PeerOutboxRedeliveryPassResult> => {
    if (running) return running;
    running = runPass(
      { ...config, shouldStop: () => stopRequested },
      () => tracker.refresh(),
      (messageId) => tracker.settle(messageId)
    ).finally(() => {
      running = undefined;
    });
    return running;
  };

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void runOnce()
        .catch((error) =>
          log.error(
            `redelivery pass failed — ${error instanceof Error ? error.message : String(error)} | will retry on the next pass | peer=${config.peerId} tenant=${config.tenantId}`
          )
        )
        .finally(() => schedule(intervalMs));
    }, delayMs);
    timer.unref?.();
  };

  return {
    runOnce,
    start() {
      if (!stopped) return;
      stopped = false;
      stopRequested = false;
      schedule(0);
    },
    async stop() {
      stopped = true;
      stopRequested = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (running) await running.catch(() => undefined);
    },
  };
}
