/** Forward-only event continuation. No automatic initialization, reset or expiry. */
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathResolver } from '../path-resolver.js';
import { safeLstat, safeReadFileRange, safeReadFileSnapshot, safeWriteFile } from '../secure-io.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import { withLockSync } from '../foundation/lock-utils.js';
import {
  dotStatePath,
  DOT_STATE_ROOT,
  DOT_EVENTS_FILE,
  type DotInboundEvent,
} from './dot-state-paths.js';
import { physicalScopedPath } from '../physical-namespace.js';
import type { DotCharter, DotTrigger } from './dot-charter.js';
import type { DotRuntimeDeps, DotWakeLedgerEntry, DueDotTrigger } from './dot-runtime.js';

export const EVENT_CONTINUATION_BYTES = 4 * 1024 * 1024;
export const EVENT_CONTINUATION_ROWS = 2000;
export const EVENT_CONTINUATION_PENDING = 128;
const SNAPSHOT_BYTES = 256 * 1024;
const ANCHOR_BYTES = 256;
const MAX_LINE_BYTES = 32 * 1024;
type EventTrigger = Extract<DotTrigger, { kind: 'event' }>;
export interface EventPending {
  event_id: string;
  key: string;
  detail: string;
  received_at: string;
  trigger_index: number;
  attempt?: { id: string; started_at: string };
}
export interface EventContinuationState {
  version: 1;
  identity: string;
  activation_id: string;
  activated_at: string;
  trigger_digest: string;
  source: {
    dev: string;
    ino: string;
    floor: number;
    floor_anchor: string;
    offset: number;
    anchor: string;
  };
  pending: EventPending[];
}
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export function eventContinuationIdentity(c: DotCharter): string {
  return JSON.stringify([
    c.scope.tier,
    c.scope.tenant_slug ?? null,
    c.scope.organization_id ?? null,
    c.scope.project_id ?? null,
    c.dot_id,
  ]);
}
export function eventContinuationPath(c: DotCharter, rootDir = pathResolver.rootDir()): string {
  return path.join(
    rootDir,
    dotStatePath(c, 'event-continuations', digest(eventContinuationIdentity(c)) + '.json')
  );
}
export function eventContinuationLedger(c: DotCharter, rootDir = pathResolver.rootDir()): string {
  const rel = c.scope.tenant_slug
    ? physicalScopedPath(DOT_STATE_ROOT, { tenant_slug: c.scope.tenant_slug }, DOT_EVENTS_FILE)
    : DOT_STATE_ROOT + '/' + DOT_EVENTS_FILE;
  return path.join(rootDir, rel);
}
export function eventIntakeLockId(file: string): string {
  return 'dot-event-intake-' + digest(file).slice(0, 24);
}
export function withEventContinuationLock<T>(c: DotCharter, deps: DotRuntimeDeps, fn: () => T): T {
  return withLockSync(
    'dot-event-continuation-' + digest(path.resolve(eventContinuationPath(c, deps.rootDir))),
    fn
  );
}
const eventTriggers = (c: DotCharter): EventTrigger[] =>
  c.attention.triggers.filter((t): t is EventTrigger => t.kind === 'event');
export function eventContinuationTriggerDigest(c: DotCharter): string {
  return digest(JSON.stringify(eventTriggers(c)));
}
export function eventContinuationKey(c: DotCharter, activation: string, eventId: string): string {
  return 'event:durable:' + digest(eventContinuationIdentity(c)) + ':' + activation + ':' + eventId;
}
export function isDurableEventKey(key: string | undefined): boolean {
  return Boolean(key?.startsWith('event:durable:'));
}
export class EventContinuationHold extends Error {
  constructor(readonly reason: string) {
    super(
      'Event continuation held: ' +
        reason +
        '; operator recovery required (never reset automatically)'
    );
  }
}
function blocked(reason: string): never {
  throw new EventContinuationHold(reason);
}

export function eventContinuationExists(c: DotCharter, deps: DotRuntimeDeps = {}): boolean {
  try {
    safeLstat(eventContinuationPath(c, deps.rootDir));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    return blocked('state is unreadable');
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const timestamp = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= 32 && Number.isFinite(Date.parse(v));
export function readEventContinuation(
  c: DotCharter,
  deps: DotRuntimeDeps = {}
): EventContinuationState | null {
  const exists = eventContinuationExists(c, deps);
  const declared = c.attention.event_delivery;
  if (!exists) {
    if (declared) return blocked('declared state is missing');
    return null;
  }
  if (!declared) return blocked('snapshot exists without its charter declaration');
  let raw: unknown;
  try {
    raw = parseSafeJsonInput(
      safeReadFileSnapshot(eventContinuationPath(c, deps.rootDir), SNAPSHOT_BYTES).toString('utf8'),
      'event continuation'
    );
  } catch {
    return blocked('state is invalid or unreadable');
  }
  if (
    !isRecord(raw) ||
    raw.version !== 1 ||
    raw.identity !== eventContinuationIdentity(c) ||
    raw.activation_id !== declared.activation_id ||
    !timestamp(raw.activated_at) ||
    raw.trigger_digest !== eventContinuationTriggerDigest(c) ||
    !isRecord(raw.source) ||
    !Array.isArray(raw.pending) ||
    raw.pending.length > EVENT_CONTINUATION_PENDING
  )
    return blocked('state identity or format differs');
  const source = raw.source;
  if (
    typeof source.dev !== 'string' ||
    typeof source.ino !== 'string' ||
    !integer(source.floor) ||
    !integer(source.offset) ||
    source.offset < source.floor ||
    !hash(source.anchor) ||
    !hash(source.floor_anchor)
  )
    return blocked('source checkpoint is invalid');
  const seen = new Set<string>();
  const triggers = eventTriggers(c);
  for (const item of raw.pending) {
    if (
      !isRecord(item) ||
      typeof item.event_id !== 'string' ||
      !/^evt_[a-f0-9]{24}$/.test(item.event_id) ||
      item.key !== eventContinuationKey(c, declared.activation_id, item.event_id) ||
      typeof item.detail !== 'string' ||
      item.detail.length > 500 ||
      !timestamp(item.received_at) ||
      !integer(item.trigger_index) ||
      !triggers[item.trigger_index] ||
      seen.has(String(item.key))
    )
      return blocked('pending entry is invalid');
    if (
      item.attempt !== undefined &&
      (!isRecord(item.attempt) ||
        typeof item.attempt.id !== 'string' ||
        !/^[a-f0-9-]{36}$/.test(item.attempt.id) ||
        !timestamp(item.attempt.started_at))
    )
      return blocked('attempt evidence is invalid');
    seen.add(String(item.key));
  }
  return raw as unknown as EventContinuationState;
}
export function writeEventContinuation(
  c: DotCharter,
  state: EventContinuationState,
  deps: DotRuntimeDeps = {},
  createOnly = false
): void {
  const text = JSON.stringify(state) + '\n';
  if (Buffer.byteLength(text) > SNAPSHOT_BYTES) blocked('snapshot exceeds its byte budget');
  safeWriteFile(eventContinuationPath(c, deps.rootDir), text, { createOnly });
}
export function eventSourceAnchor(file: string, offset: number): string {
  if (offset === 0) return digest('');
  return digest(
    safeReadFileRange(file, Math.max(0, offset - ANCHOR_BYTES), Math.min(offset, ANCHOR_BYTES))
  );
}
export function assertEventSource(
  c: DotCharter,
  state: EventContinuationState,
  deps: DotRuntimeDeps = {}
): number {
  const file = eventContinuationLedger(c, deps.rootDir);
  let stat: ReturnType<typeof safeLstat>;
  try {
    stat = safeLstat(file);
  } catch {
    return blocked('source is missing or unreadable');
  }
  if (
    !stat.isFile() ||
    String(stat.dev) !== state.source.dev ||
    String(stat.ino) !== state.source.ino ||
    stat.size < state.source.offset
  )
    return blocked('source was rotated or truncated');
  if (
    eventSourceAnchor(file, state.source.floor) !== state.source.floor_anchor ||
    eventSourceAnchor(file, state.source.offset) !== state.source.anchor
  )
    return blocked('source continuity changed');
  return stat.size;
}
export function initialEventContinuation(
  c: DotCharter,
  activation: string,
  deps: DotRuntimeDeps = {}
): EventContinuationState {
  const file = eventContinuationLedger(c, deps.rootDir);
  const stat = safeLstat(file);
  if (!stat.isFile() || (stat.size > 0 && safeReadFileRange(file, stat.size - 1, 1)[0] !== 10))
    return blocked('activation requires a regular source ending at a complete line');
  const anchor = eventSourceAnchor(file, stat.size);
  return {
    version: 1,
    identity: eventContinuationIdentity(c),
    activation_id: activation,
    activated_at: (deps.now?.() ?? new Date()).toISOString(),
    trigger_digest: eventContinuationTriggerDigest(c),
    source: {
      dev: String(stat.dev),
      ino: String(stat.ino),
      floor: stat.size,
      floor_anchor: anchor,
      offset: stat.size,
      anchor,
    },
    pending: [],
  };
}
function terminal(row: DotWakeLedgerEntry, item: EventPending, dotId: string): boolean {
  if (row.dot_id !== dotId || row.trigger_key !== item.key) return false;
  if (row.outcome === 'rejected' && !item.attempt) return true;
  return (
    (row.outcome === 'rejected' || (row.outcome === 'delivered' && !row.trigger_retained)) &&
    typeof row.event_attempt_id === 'string' &&
    (!item.attempt || row.event_attempt_id === item.attempt.id)
  );
}
/** Null means legacy mode. Read event bytes and pending state are bounded; the existing wake receipt reader is not. */
export function evaluateEventContinuation(
  c: DotCharter,
  deps: DotRuntimeDeps,
  ports: {
    matches: (event: DotInboundEvent, trigger: EventTrigger) => boolean;
    receipts: () => DotWakeLedgerEntry[];
    isDue: (key: string) => boolean;
  }
): DueDotTrigger[] | null {
  if (!c.attention.event_delivery && !eventContinuationExists(c, deps)) return null;
  return withEventContinuationLock(c, deps, () => {
    const state = readEventContinuation(c, deps);
    if (!state) return null;
    return withLockSync(eventIntakeLockId(eventContinuationLedger(c, deps.rootDir)), () => {
      const size = assertEventSource(c, state, deps);
      const receipts = ports.receipts();
      state.pending = state.pending.filter(
        (item) => !receipts.some((row) => terminal(row, item, c.dot_id))
      );
      const file = eventContinuationLedger(c, deps.rootDir);
      const triggers = eventTriggers(c);
      let processed = 0;
      if (state.pending.length < EVENT_CONTINUATION_PENDING && size > state.source.offset) {
        const bytes = safeReadFileRange(
          file,
          state.source.offset,
          Math.min(EVENT_CONTINUATION_BYTES, size - state.source.offset)
        );
        let start = 0;
        while (
          processed < EVENT_CONTINUATION_ROWS &&
          state.pending.length < EVENT_CONTINUATION_PENDING
        ) {
          const end = bytes.indexOf(10, start);
          if (end < 0) {
            if (bytes.length - start > MAX_LINE_BYTES)
              blocked('source line exceeds its byte budget');
            break;
          }
          if (end - start > MAX_LINE_BYTES) blocked('source line exceeds its byte budget');
          const line = bytes.subarray(start, end).toString('utf8').trim();
          processed++;
          if (line) {
            let value: unknown;
            try {
              value = parseSafeJsonInput(line, 'event continuation source');
            } catch {
              return blocked('malformed complete source line');
            }
            if (
              !isRecord(value) ||
              typeof value.event_id !== 'string' ||
              !/^evt_[a-f0-9]{24}$/.test(value.event_id) ||
              typeof value.source !== 'string' ||
              typeof value.type !== 'string' ||
              typeof value.delivery_id !== 'string' ||
              typeof value.summary !== 'string' ||
              !timestamp(value.received_at) ||
              (value.tenant_slug || undefined) !== (c.scope.tenant_slug || undefined)
            )
              return blocked('invalid or foreign-scope source row');
            const event = value as unknown as DotInboundEvent;
            const index = triggers.findIndex((trigger) => ports.matches(event, trigger));
            if (index >= 0) {
              const key = eventContinuationKey(c, state.activation_id, event.event_id);
              const item: EventPending = {
                event_id: event.event_id,
                key,
                received_at: event.received_at,
                trigger_index: index,
                detail: (
                  'event ' +
                  event.source +
                  '/' +
                  event.type +
                  ' delivery ' +
                  event.delivery_id +
                  ' received ' +
                  event.received_at +
                  ' (untrusted external input): ' +
                  event.summary
                ).slice(0, 500),
              };
              if (
                !state.pending.some((p) => p.key === key) &&
                !receipts.some((r) => terminal(r, item, c.dot_id))
              )
                state.pending.push(item);
            }
          }
          start = end + 1;
        }
        state.source.offset += start;
        state.source.anchor = eventSourceAnchor(file, state.source.offset);
        assertEventSource(c, state, deps);
      }
      // Persist discovery before offering. An offer is never an acknowledgement.
      writeEventContinuation(c, state, deps);
      const now = (deps.now?.() ?? new Date()).getTime();
      return state.pending
        .filter(
          (item) => !item.attempt && Date.parse(item.received_at) <= now && ports.isDue(item.key)
        )
        .slice(0, 5)
        .map((item) => ({
          trigger: triggers[item.trigger_index],
          key: item.key,
          detail: item.detail,
        }));
    });
  });
}
/** CAS inside the runner callback, immediately before provider invocation. An ambiguous attempt never expires. */
export function claimEventContinuation(
  c: DotCharter,
  trigger: DueDotTrigger | undefined,
  deps: DotRuntimeDeps = {}
): string | null {
  if (trigger?.trigger.kind !== 'event') return null;
  if (
    !c.attention.event_delivery &&
    !isDurableEventKey(trigger.key) &&
    !eventContinuationExists(c, deps)
  )
    return null;
  return withEventContinuationLock(c, deps, () => {
    const state = readEventContinuation(c, deps);
    if (!state) {
      if (isDurableEventKey(trigger.key)) return blocked('stale durable offer');
      return null;
    }
    const item = state.pending.find((p) => p.key === trigger.key);
    if (!item || item.attempt) return blocked('stale offer or unresolved dispatched attempt');
    assertEventSource(c, state, deps);
    item.attempt = { id: randomUUID(), started_at: (deps.now?.() ?? new Date()).toISOString() };
    writeEventContinuation(c, state, deps);
    return item.attempt.id;
  });
}
/** A verified terminal runner receipt is event-terminal, not a lease/duplicate acknowledgement. */
export function reconcileEventRunnerTerminal(
  c: DotCharter,
  key: string,
  receipt: {
    idempotencyKey: string;
    status: string;
  },
  deps: DotRuntimeDeps = {}
): void {
  if (
    !isDurableEventKey(key) ||
    receipt.idempotencyKey !== 'dot:' + c.dot_id + ':' + key ||
    (receipt.status !== 'delivered' && receipt.status !== 'rejected')
  )
    return;
  withEventContinuationLock(c, deps, () => {
    const state = readEventContinuation(c, deps);
    if (!state || !state.pending.some((p) => p.key === key)) return;
    state.pending = state.pending.filter((p) => p.key !== key);
    writeEventContinuation(c, state, deps);
  });
}

/** Refuse queued legacy or differently scoped offers after charter adoption/change. */
export function eventContinuationCharterChanged(
  original: DotCharter,
  current: DotCharter,
  trigger?: DueDotTrigger
): boolean {
  return (
    trigger?.trigger.kind === 'event' &&
    (eventContinuationIdentity(current) !== eventContinuationIdentity(original) ||
      current.attention.event_delivery?.activation_id !==
        original.attention.event_delivery?.activation_id ||
      Boolean(current.attention.event_delivery) !== isDurableEventKey(trigger.key))
  );
}

/** Partial output application is ambiguous after dispatch, never delivered. */
export function assertEventContinuationOutput(
  attemptId: string | undefined,
  errorCount: number
): void {
  if (attemptId && errorCount > 0)
    throw new Error(
      'Durable event output is unresolved; dispatched attempt retained for operator recovery'
    );
}
