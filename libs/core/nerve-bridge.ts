import { appendJsonLine } from './foundation/json.js';
import { nowIso } from './foundation/time.js';
/**
 * libs/core/nerve-bridge.ts
 * Kyberion Autonomous Nerve System (KANS) - Nerve Bridge v1.2
 * [SECURE-IO COMPLIANT]
 *
 * Provides structured messaging (To/From/Type) over the stimuli bus
 * with Distributed Node Identification (Nerve Cluster Foundation).
 */

import * as os from 'node:os';
import { createLogger } from './logger.js';
import { pathResolver } from './path-resolver.js';
import { subscribeJsonl } from './jsonl-tail.js';
import {
  isStimulusExpired,
  normalizeNerveMessage,
  rotateStimuliJournalIfNeeded,
} from './stimuli-journal.js';

const logger = createLogger('nerve-bridge');

const STIMULI_PATH = pathResolver.resolve('presence/bridge/runtime/stimuli.jsonl');
const NODE_ID = `${os.hostname()}-${process.pid}`;

export interface NerveMessage {
  id: string;
  ts: string;
  from: string;
  node_id: string; // Distributed Node Identity
  to: string | 'broadcast';
  type: 'request' | 'response' | 'event';
  intent: string;
  payload: any;
  metadata?: {
    reply_to?: string;
    mission_id?: string;
    ttl?: number;
  };
}

/**
 * Send a structured message to the nerve bus
 */
export function sendNerveMessage(input: {
  to: string | 'broadcast';
  from: string;
  intent: string;
  payload: any;
  type?: NerveMessage['type'];
  replyTo?: string;
}): string {
  const msg: NerveMessage = {
    id: `msg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    ts: nowIso(),
    from: input.from,
    node_id: NODE_ID,
    to: input.to,
    type: input.type || 'event',
    intent: input.intent,
    payload: input.payload,
    metadata: {
      reply_to: input.replyTo,
      mission_id: process.env.MISSION_ID,
      ttl: 60,
    },
  };

  try {
    appendJsonLine(STIMULI_PATH, msg);
    rotateStimuliJournalIfNeeded();
    logger.info(`📡 [BRIDGE:${NODE_ID}] Message sent: ${msg.intent} (${msg.from} -> ${msg.to})`);
  } catch (err) {
    logger.warn(`[nerve-bridge] suppressed error in sendNerveMessage: ${err}`);
  }

  return msg.id;
}

export interface ListenToNerveOptions {
  intervalMs?: number;
  /** Deliver stimuli already in the journal. Default false: only new ones. */
  fromBeginning?: boolean;
  /** Deliver stimuli past their declared TTL. Default false. */
  deliverExpired?: boolean;
  signal?: AbortSignal;
}

/**
 * Follow the stimuli journal and deliver messages addressed to `nerveId`.
 *
 * EV-04/EV-08: this used to track a byte offset and compare it against the file
 * size, which silently stopped delivering for good once the journal was rotated
 * or truncated (the recorded offset then permanently exceeded the real size).
 * `subscribeJsonl` owns rotation detection and partial-line handling now, so
 * this function is only routing policy: loopback suppression, addressing, TTL.
 *
 * Returns an unsubscribe function.
 */
export function listenToNerve(
  nerveId: string,
  onMessage: (msg: NerveMessage) => void,
  options: ListenToNerveOptions = {}
): () => void {
  logger.info(`👂 [BRIDGE:${NODE_ID}] Nerve '${nerveId}' started listening...`);

  return subscribeJsonl<NerveMessage>(
    STIMULI_PATH,
    (msg) => {
      // Not addressed to us, or emitted by this very process (loopback).
      if (msg.to !== nerveId && msg.to !== 'broadcast') return;
      if (msg.node_id === NODE_ID) return;
      if (!options.deliverExpired && isStimulusExpired(msg)) {
        logger.info(`[nerve-bridge] dropping expired stimulus ${msg.id} (intent=${msg.intent})`);
        return;
      }
      onMessage(msg);
    },
    {
      intervalMs: options.intervalMs ?? 1000,
      fromBeginning: options.fromBeginning ?? false,
      parse: normalizeNerveMessage,
      ...(options.signal ? { signal: options.signal } : {}),
      onMalformed: (line, err) =>
        logger.warn(
          `[nerve-bridge] unparseable stimulus line skipped: ${err instanceof Error ? err.message : String(err)} (${line.slice(0, 120)})`
        ),
    }
  );
}
