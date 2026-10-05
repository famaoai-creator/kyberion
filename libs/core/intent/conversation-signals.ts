import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { isVitestProcess } from '../foundation/env.js';
import { appendJsonLine, readJsonLines } from '../foundation/json.js';
import { createLogger } from '../logger.js';
import * as pathResolver from '../path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeMkdir, safeReaddir } from '../secure-io.js';

const logger = createLogger('conversation-signals');

/**
 * The conversation signal ledger: one typed, append-only record of "how did
 * this turn go" for the operator-facing conversation.
 *
 * Before it, that question was answered by four unconnected stores (intent
 * contract memory, execution feedback, the unhandled-intent registry, and a
 * write-only contextual-intent log), none of which could be joined, and nothing
 * fed what they learned back into the evaluation corpus. Producers append here
 * through `recordConversationSignal`; consumers read through
 * `summarizeConversationSignals` (the `conversation report` command).
 *
 * Privacy contract, enforced here rather than at each call site:
 *  - a turn in a tenant scope, or an isolated (tenant) turn, is never recorded;
 *  - otherwise only metadata is stored (kind, intent, surface, correlation id,
 *    a short hash and the length of the utterance) plus an excerpt of at most
 *    100 characters, so repeated misses can be clustered and reviewed.
 */

export const CONVERSATION_SIGNAL_KINDS = [
  'route_unrecognized',
  'route_unrouted',
  'clarification_asked',
  'clarification_answered',
  'feedback_satisfied',
  'feedback_partial',
  'feedback_dissatisfied',
  'turn_succeeded',
  'turn_failed',
] as const;

export type ConversationSignalKind = (typeof CONVERSATION_SIGNAL_KINDS)[number];

export type ConversationSignalDetail = Record<string, string | number | boolean>;

export interface ConversationSignal {
  signal_id: string;
  ts: string;
  kind: ConversationSignalKind;
  correlation_id?: string;
  intent_id?: string;
  surface?: string;
  locale?: string;
  /** First 16 hex characters of the utterance's SHA-256; clusters repeats without text. */
  utterance_hash?: string;
  utterance_length?: number;
  /** At most EXCERPT_LENGTH characters, whitespace-collapsed. Never set for tenant turns. */
  excerpt?: string;
  detail?: ConversationSignalDetail;
}

export interface RecordConversationSignalInput {
  kind: ConversationSignalKind;
  utterance?: string;
  correlationId?: string;
  intentId?: string;
  surface?: string;
  locale?: string;
  /** The turn's tenant scope when the caller knows it; a set `tenant_slug` suppresses the record. */
  scope?: { tenant_slug?: string } | null;
  /** An isolated (tenant) turn; suppresses the record. */
  isolated?: boolean;
  detail?: ConversationSignalDetail;
  now?: Date;
}

export const EXCERPT_LENGTH = 100;
const DETAIL_VALUE_LENGTH = 120;
const ROOT_REL = 'runtime/conversation-signals';

let configuredRoot: string | null | undefined;

/**
 * Routing is resolved more than once per turn, so the same miss would be written
 * several times. Identical route misses inside this window collapse to one.
 */
const ROUTE_DEDUPE_WINDOW_MS = 60_000;
const recentRouteMisses = new Map<string, number>();

function isDuplicateRouteMiss(
  kind: ConversationSignalKind,
  hash: string | undefined,
  intentId: string | undefined,
  nowMs: number
): boolean {
  if (kind !== 'route_unrecognized' && kind !== 'route_unrouted') return false;
  const key = `${kind}|${hash ?? ''}|${intentId ?? ''}`;
  const last = recentRouteMisses.get(key);
  if (last !== undefined && nowMs - last < ROUTE_DEDUPE_WINDOW_MS) return true;
  recentRouteMisses.set(key, nowMs);
  if (recentRouteMisses.size > 500) {
    const oldest = recentRouteMisses.keys().next().value;
    if (oldest !== undefined) recentRouteMisses.delete(oldest);
  }
  return false;
}

/** Test seam: forget which route misses were just written. */
export function resetConversationSignalDedupe(): void {
  recentRouteMisses.clear();
}

/**
 * Point the ledger at another directory (tests, a replay). `null` disables it.
 * Left unset, the ledger writes under the shared runtime directory, except under
 * vitest, where it writes nothing so a test run cannot pollute the real ledger.
 */
export function configureConversationSignalRoot(root: string | null | undefined): void {
  configuredRoot = root;
}

function ledgerRoot(): string | null {
  if (configuredRoot !== undefined) return configuredRoot;
  if (isVitestProcess()) return null;
  return pathResolver.shared(ROOT_REL);
}

function ledgerFile(root: string, at: Date): string {
  const month = at.toISOString().slice(0, 7);
  return assertSafeRepositoryPath(path.join(root, `${month}.jsonl`), { allowMissingLeaf: true });
}

function collapse(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function clampDetail(
  detail: ConversationSignalDetail | undefined
): ConversationSignalDetail | undefined {
  if (!detail) return undefined;
  const out: ConversationSignalDetail = {};
  for (const [key, value] of Object.entries(detail)) {
    out[key] = typeof value === 'string' ? value.slice(0, DETAIL_VALUE_LENGTH) : value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Append one signal. Best effort and never throws: the conversation must not
 * fail because its bookkeeping did. Returns the stored signal, or null when the
 * turn is not recordable (tenant or isolated) or the ledger is off.
 */
export function recordConversationSignal(
  input: RecordConversationSignalInput
): ConversationSignal | null {
  try {
    if (input.isolated || input.scope?.tenant_slug) return null;
    const root = ledgerRoot();
    if (!root) return null;
    const at = input.now ?? new Date();
    const text = typeof input.utterance === 'string' ? collapse(input.utterance) : '';
    const hash = text ? createHash('sha256').update(text).digest('hex').slice(0, 16) : undefined;
    if (isDuplicateRouteMiss(input.kind, hash, input.intentId, at.getTime())) return null;
    const signal: ConversationSignal = {
      signal_id: randomUUID(),
      ts: at.toISOString(),
      kind: input.kind,
      ...(input.correlationId ? { correlation_id: input.correlationId } : {}),
      ...(input.intentId ? { intent_id: input.intentId } : {}),
      ...(input.surface ? { surface: input.surface } : {}),
      ...(input.locale ? { locale: input.locale } : {}),
      ...(text
        ? {
            utterance_hash: hash,
            utterance_length: text.length,
            excerpt: text.slice(0, EXCERPT_LENGTH),
          }
        : {}),
      ...(clampDetail(input.detail) ? { detail: clampDetail(input.detail) } : {}),
    };
    const file = ledgerFile(root, at);
    if (!safeExistsSync(root)) safeMkdir(root, { recursive: true });
    appendJsonLine(file, signal);
    return signal;
  } catch (error) {
    logger.debug(
      `conversation signal not recorded — ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

function isSignal(value: unknown): value is ConversationSignal {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.ts === 'string' &&
    typeof record.signal_id === 'string' &&
    (CONVERSATION_SIGNAL_KINDS as readonly string[]).includes(String(record.kind))
  );
}

export function listConversationSignals(
  options: { sinceMs?: number; kinds?: readonly ConversationSignalKind[] } = {}
): ConversationSignal[] {
  const root = ledgerRoot();
  if (!root || !safeExistsSync(root)) return [];
  const signals: ConversationSignal[] = [];
  for (const name of safeReaddir(root)
    .filter((entry) => entry.endsWith('.jsonl'))
    .sort()) {
    const file = assertSafeRepositoryPath(path.join(root, name), { allowMissingLeaf: true });
    for (const value of readJsonLines<unknown>(file, { onMalformed: 'skip' })) {
      if (!isSignal(value)) continue;
      if (options.sinceMs !== undefined && Date.parse(value.ts) < options.sinceMs) continue;
      if (options.kinds && !options.kinds.includes(value.kind)) continue;
      signals.push(value);
    }
  }
  return signals;
}

export interface IntentSignalSummary {
  intent_id: string;
  turns: number;
  succeeded: number;
  failed: number;
  unhandled: number;
  dissatisfied: number;
  clarification_asked: number;
  clarification_abandoned: number;
}

export interface MissCluster {
  utterance_hash: string;
  count: number;
  kinds: ConversationSignalKind[];
  intent_id?: string;
  excerpt?: string;
  first_seen: string;
  last_seen: string;
}

export interface ConversationSignalSummary {
  total: number;
  by_kind: Partial<Record<ConversationSignalKind, number>>;
  by_intent: IntentSignalSummary[];
  clarification: { asked: number; abandoned: number; abandon_rate: number | null };
  /** Repeated misses and dissatisfaction, grouped by utterance. Review candidates only. */
  miss_clusters: MissCluster[];
}

/**
 * A clarification is abandoned when no answer arrived within the pending-intent
 * TTL (libs/core/pending-intent-store.ts, 24 h). It is derived at read time from
 * `clarification_asked` / `clarification_answered` pairs rather than stored: the
 * pending record carries no tenant scope, so its expiry cannot be attributed.
 */
export const CLARIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

const MISS_KINDS: readonly ConversationSignalKind[] = [
  'route_unrecognized',
  'route_unrouted',
  'feedback_dissatisfied',
  'turn_failed',
];

export function summarizeConversationSignals(
  signals: readonly ConversationSignal[],
  options: { nowMs?: number } = {}
): ConversationSignalSummary {
  const nowMs = options.nowMs ?? Date.now();
  // A chain of clarifications reuses one pending key, so "answered" is judged
  // per question: was there an answer for this key at or after the question?
  const lastAnswerAt = new Map<string, number>();
  for (const signal of signals) {
    const key = signal.kind === 'clarification_answered' ? signal.detail?.pending_key : undefined;
    if (!key) continue;
    lastAnswerAt.set(
      String(key),
      Math.max(lastAnswerAt.get(String(key)) ?? 0, Date.parse(signal.ts))
    );
  }
  const byKind: Partial<Record<ConversationSignalKind, number>> = {};
  const intents = new Map<string, IntentSignalSummary>();
  const clusters = new Map<string, MissCluster>();
  let asked = 0;
  let abandoned = 0;

  for (const signal of signals) {
    byKind[signal.kind] = (byKind[signal.kind] ?? 0) + 1;
    const abandonedAsk =
      signal.kind === 'clarification_asked' &&
      Boolean(signal.detail?.pending_key) &&
      (lastAnswerAt.get(String(signal.detail?.pending_key)) ?? 0) < Date.parse(signal.ts) &&
      nowMs - Date.parse(signal.ts) > CLARIFICATION_TTL_MS;
    if (signal.kind === 'clarification_asked') asked += 1;
    if (abandonedAsk) abandoned += 1;

    if (signal.intent_id) {
      const entry = intents.get(signal.intent_id) ?? {
        intent_id: signal.intent_id,
        turns: 0,
        succeeded: 0,
        failed: 0,
        unhandled: 0,
        dissatisfied: 0,
        clarification_asked: 0,
        clarification_abandoned: 0,
      };
      if (signal.kind === 'turn_succeeded') {
        entry.turns += 1;
        entry.succeeded += 1;
      } else if (signal.kind === 'turn_failed') {
        entry.turns += 1;
        entry.failed += 1;
      } else if (signal.kind === 'route_unrouted' || signal.kind === 'route_unrecognized') {
        entry.unhandled += 1;
      } else if (signal.kind === 'feedback_dissatisfied') {
        entry.dissatisfied += 1;
      } else if (signal.kind === 'clarification_asked') {
        entry.clarification_asked += 1;
        if (abandonedAsk) entry.clarification_abandoned += 1;
      }
      intents.set(signal.intent_id, entry);
    }

    if (MISS_KINDS.includes(signal.kind) && signal.utterance_hash) {
      const cluster = clusters.get(signal.utterance_hash) ?? {
        utterance_hash: signal.utterance_hash,
        count: 0,
        kinds: [],
        first_seen: signal.ts,
        last_seen: signal.ts,
        ...(signal.intent_id ? { intent_id: signal.intent_id } : {}),
        ...(signal.excerpt ? { excerpt: signal.excerpt } : {}),
      };
      cluster.count += 1;
      if (!cluster.kinds.includes(signal.kind)) cluster.kinds.push(signal.kind);
      if (signal.ts < cluster.first_seen) cluster.first_seen = signal.ts;
      if (signal.ts > cluster.last_seen) cluster.last_seen = signal.ts;
      clusters.set(signal.utterance_hash, cluster);
    }
  }

  return {
    total: signals.length,
    by_kind: byKind,
    by_intent: [...intents.values()].sort(
      (a, b) =>
        b.unhandled + b.failed + b.dissatisfied - (a.unhandled + a.failed + a.dissatisfied) ||
        a.intent_id.localeCompare(b.intent_id)
    ),
    clarification: {
      asked,
      abandoned,
      abandon_rate: asked > 0 ? Math.round((abandoned / asked) * 1000) / 1000 : null,
    },
    miss_clusters: [...clusters.values()].sort(
      (a, b) => b.count - a.count || a.utterance_hash.localeCompare(b.utterance_hash)
    ),
  };
}
