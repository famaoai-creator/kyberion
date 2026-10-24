/**
 * Feed intake — the pull-side adapter in front of the governed event intake.
 *
 * Some sources cannot push: a Slack keyword search, a ticket query, a search
 * result set. A charter declares a `feed` trigger naming one read-only service
 * preset operation, and this module polls it on a bounded cadence, keeps a
 * durable cursor plus a bounded seen-key ring per (dot, feed spec), and turns
 * newly observed items into normal intake events under a declared source.
 *
 * Design rules (these are the reason this is not a second notification path):
 * - A feed never wakes a dot. It only ingests; the charter's matching `event`
 *   trigger wakes the dot through the existing wake ledger, gate and budget.
 * - The tenant comes from the intake policy, never from the payload. A feed
 *   whose source is bound to a different tenant than the charter refuses to
 *   run instead of writing into another tenant's ledger.
 * - The cursor is a rank, not a promise of exactly-once. `ingestLocalEvent`
 *   still dedupes by delivery id, so a replayed item cannot produce a second
 *   event even if the seen ring was evicted.
 * - The first poll only establishes a baseline unless the operator asks for
 *   `emit`, so activating a feed never wakes the dot on backlog.
 * - Failing polls back off, are recorded, and stay visible in `dot intake`
 *   coverage. A feed that silently stops is the failure mode this avoids.
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeMkdir } from '../secure-io.js';
import { readJsonIfPresent, writeJson } from '../foundation/json.js';
import { createLogger } from '../logger.js';
import type { DotCharter, DotFeedTrigger } from './dot-charter.js';
import {
  ingestLocalEvent,
  loadEventIntakePolicy,
  readEventJsonPath,
  type EventIntakePolicy,
  type IngestInboundEventResult,
} from './dot-event-intake.js';
import { dotStatePath, DOT_FEED_DIR } from './dot-state-paths.js';
import type { DotRuntimeDeps } from './dot-runtime.js';

const logger = createLogger('dot-feed-source');

/** Default poll cadence; a feed is a watch, not a stream. */
export const DOT_FEED_DEFAULT_EVERY_S = 300;
/** Newest items considered per poll. */
export const DOT_FEED_DEFAULT_MAX_ITEMS = 50;
/** Upper bound of remembered item identities per feed (eviction is oldest-first). */
export const DOT_FEED_SEEN_LIMIT = 500;
/** One wedged provider must not stall the sweep. */
export const DOT_FEED_FETCH_TIMEOUT_MS = 20_000;
/** Failures double the poll interval, up to this factor. */
export const DOT_FEED_MAX_BACKOFF_FACTOR = 8;
/** A feed failing twice, or not succeeding for three cadences, is reported stalled. */
export const DOT_FEED_STALL_AFTER_FAILURES = 2;

const ERROR_MAX = 300;
const DETAIL_MAX = 300;

/** One poll's durable cursor/seen bookkeeping. One file per feed spec. */
export interface DotFeedState {
  spec_id: string;
  source: string;
  service_id: string;
  action: string;
  /** Highest observed ordering value (as text). */
  cursor?: string;
  /** Bounded ring of already-ingested item identities, oldest first. */
  seen: string[];
  /** Set on the first successful poll; absent means the feed never polled successfully. */
  seeded_at?: string;
  last_poll_at?: string;
  last_success_at?: string;
  last_error?: string;
  consecutive_failures: number;
  /** First failure of the current streak (cleared on success). */
  stalled_since?: string;
  ingested: number;
  duplicates: number;
  capped_polls: number;
}

export interface DotFeedDeps extends DotRuntimeDeps {
  /** Governed service-preset port; absent → the feed fails closed without a poll. */
  serviceCall?: (input: {
    service_id: string;
    action: string;
    params?: Record<string, unknown>;
  }) => Promise<unknown>;
  policy?: EventIntakePolicy;
  /** Ingestion seam (tests / alternate ledger). */
  ingest?: (input: Parameters<typeof ingestLocalEvent>[0]) => IngestInboundEventResult;
}

export type DotFeedPoll = {
  spec_id: string;
  source: string;
  action: string;
  status: 'polled' | 'baseline' | 'skipped' | 'failed';
  observed: number;
  ingested: number;
  duplicate: number;
  below_cursor: number;
  truncated: boolean;
  error?: string;
};

export interface DotFeedCoverage {
  spec_id: string;
  source: string;
  service_id: string;
  action: string;
  event_type: string;
  state: 'never_polled' | 'baseline' | 'healthy' | 'failing' | 'stalled';
  cursor?: string;
  seeded_at?: string;
  last_poll_at?: string;
  last_success_at?: string;
  next_poll_at?: string;
  consecutive_failures: number;
  last_error?: string;
  ingested: number;
  duplicates: number;
  capped_polls: number;
  detail: string;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(',')}}`;
}

/**
 * Identity of the feed declaration. Params participate, so pointing one feed
 * at a different query starts a new cursor instead of silently reusing one.
 */
export function feedSpecId(trigger: DotFeedTrigger): string {
  const identity = {
    source: trigger.source,
    service_id: trigger.service_id,
    action: trigger.action,
    params: trigger.params ?? {},
    items_path: trigger.items_path ?? null,
    item_id_path: trigger.item_id_path ?? 'id',
    cursor_path: trigger.cursor_path ?? trigger.item_id_path ?? 'id',
    event_type: trigger.event_type ?? 'feed',
  };
  return createHash('sha256').update(stableSerialize(identity)).digest('hex').slice(0, 16);
}

function absolute(rel: string, deps: DotRuntimeDeps): string {
  return path.join(deps.rootDir ?? pathResolver.rootDir(), rel);
}

/** Repo-relative state path for one feed of one charter (tenant-scoped). */
export function feedStatePath(charter: DotCharter, specId: string): string {
  return dotStatePath(charter, DOT_FEED_DIR, `${specId}.json`);
}

function emptyState(trigger: DotFeedTrigger, specId: string): DotFeedState {
  return {
    spec_id: specId,
    source: trigger.source,
    service_id: trigger.service_id,
    action: trigger.action,
    seen: [],
    consecutive_failures: 0,
    ingested: 0,
    duplicates: 0,
    capped_polls: 0,
  };
}

/** Corrupt state is treated as "never polled" — the existing delivery-id dedupe still holds. */
export function readFeedState(
  charter: DotCharter,
  trigger: DotFeedTrigger,
  deps: DotRuntimeDeps = {}
): DotFeedState {
  const specId = feedSpecId(trigger);
  const filePath = absolute(feedStatePath(charter, specId), deps);
  if (!safeExistsSync(filePath)) return emptyState(trigger, specId);
  try {
    const raw = readJsonIfPresent<Record<string, unknown>>(filePath);
    if (!raw || typeof raw !== 'object') return emptyState(trigger, specId);
    const seen = Array.isArray(raw.seen)
      ? raw.seen
          .filter((entry): entry is string => typeof entry === 'string')
          .slice(-DOT_FEED_SEEN_LIMIT)
      : [];
    return {
      spec_id: specId,
      source: trigger.source,
      service_id: trigger.service_id,
      action: trigger.action,
      ...(typeof raw.cursor === 'string' ? { cursor: raw.cursor } : {}),
      seen,
      ...(typeof raw.seeded_at === 'string' ? { seeded_at: raw.seeded_at } : {}),
      ...(typeof raw.last_poll_at === 'string' ? { last_poll_at: raw.last_poll_at } : {}),
      ...(typeof raw.last_success_at === 'string' ? { last_success_at: raw.last_success_at } : {}),
      ...(typeof raw.last_error === 'string' ? { last_error: raw.last_error } : {}),
      consecutive_failures:
        typeof raw.consecutive_failures === 'number' && Number.isFinite(raw.consecutive_failures)
          ? Math.max(0, raw.consecutive_failures)
          : 0,
      ...(typeof raw.stalled_since === 'string' ? { stalled_since: raw.stalled_since } : {}),
      ingested: typeof raw.ingested === 'number' ? raw.ingested : 0,
      duplicates: typeof raw.duplicates === 'number' ? raw.duplicates : 0,
      capped_polls: typeof raw.capped_polls === 'number' ? raw.capped_polls : 0,
    };
  } catch (error) {
    logger.warn(
      `feed state unreadable for ${charter.dot_id} (${specId}) — treating as never polled | next: inspect ${feedStatePath(charter, specId)} | evidence: ${error instanceof Error ? error.message : String(error)}`
    );
    return emptyState(trigger, specId);
  }
}

function writeFeedState(charter: DotCharter, state: DotFeedState, deps: DotRuntimeDeps): void {
  const filePath = absolute(feedStatePath(charter, state.spec_id), deps);
  safeMkdir(path.dirname(filePath), { recursive: true });
  writeJson(filePath, state);
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, ' ')
    .slice(0, ERROR_MAX);
}

function everyS(trigger: DotFeedTrigger): number {
  return trigger.every_s ?? DOT_FEED_DEFAULT_EVERY_S;
}

function maxItems(trigger: DotFeedTrigger): number {
  return trigger.max_items ?? DOT_FEED_DEFAULT_MAX_ITEMS;
}

/** Rolling cadence: a failing feed backs off instead of hammering the provider. */
function pollIntervalMs(trigger: DotFeedTrigger, state: DotFeedState): number {
  const factor = Math.min(
    2 ** Math.min(state.consecutive_failures, 4),
    DOT_FEED_MAX_BACKOFF_FACTOR
  );
  return everyS(trigger) * 1000 * factor;
}

function isPollDue(trigger: DotFeedTrigger, state: DotFeedState, now: Date): boolean {
  if (!state.last_poll_at) return true;
  const last = Date.parse(state.last_poll_at);
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= pollIntervalMs(trigger, state);
}

// ---------------------------------------------------------------------------
// ordering
// ---------------------------------------------------------------------------

type CursorRank = { kind: 'number' | 'date' | 'string'; value: number | string };

/**
 * Ranks an ordering value. Slack `ts` and ISO timestamps both rank correctly;
 * anything else falls back to a plain string comparison so a feed with no
 * parseable cursor still makes progress.
 */
export function cursorRank(value: unknown): CursorRank | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { kind: 'number', value };
  }
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const text = value.trim();
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    return { kind: 'number', value: Number(text) };
  }
  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) return { kind: 'date', value: parsed };
  return { kind: 'string', value: text };
}

/** Negative when `a` precedes `b`. Mixed kinds compare as strings, never throw. */
export function compareCursorRanks(a: CursorRank | undefined, b: CursorRank | undefined): number {
  if (!a || !b) return 0;
  if (a.kind === b.kind && a.kind !== 'string') {
    return Number(a.value) - Number(b.value);
  }
  return String(a.value).localeCompare(String(b.value));
}

function rankText(rank: CursorRank | undefined): string | undefined {
  return rank ? String(rank.value) : undefined;
}

// ---------------------------------------------------------------------------
// source binding
// ---------------------------------------------------------------------------

/**
 * The feed's source must be declared and bound to the charter's own tenant.
 * Everything else is refused before a single provider call, so a feed can
 * never write tenant A's data into tenant B's ledger.
 */
export function resolveFeedSourceBinding(
  trigger: DotFeedTrigger,
  charter: DotCharter,
  policy: EventIntakePolicy
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(policy.sources, trigger.source)) {
    return `source '${trigger.source}' is not declared in the event-intake policy`;
  }
  const sourceTenant = policy.sources[trigger.source].tenant_slug ?? undefined;
  const charterTenant = charter.scope.tenant_slug ?? undefined;
  if (sourceTenant !== charterTenant) {
    return `source '${trigger.source}' is bound to tenant '${sourceTenant ?? '(system)'}' but the charter is '${charterTenant ?? '(system)'}'`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// polling
// ---------------------------------------------------------------------------

interface FeedItem {
  index: number;
  key: string;
  cursor?: CursorRank;
  raw: unknown;
}

function extractItems(raw: unknown, trigger: DotFeedTrigger): unknown[] | undefined {
  const candidate = trigger.items_path
    ? readEventJsonPath(raw, trigger.items_path)
    : Array.isArray(raw)
      ? raw
      : readEventJsonPath(raw, 'items');
  return Array.isArray(candidate) ? candidate : undefined;
}

function projectItems(
  items: unknown[],
  trigger: DotFeedTrigger
): {
  items: FeedItem[];
  invalid: number;
} {
  const idPath = trigger.item_id_path ?? 'id';
  const cursorPath = trigger.cursor_path ?? idPath;
  const projected: FeedItem[] = [];
  let invalid = 0;
  items.forEach((raw, index) => {
    const keyValue = readEventJsonPath(raw, idPath);
    const key =
      typeof keyValue === 'string' || typeof keyValue === 'number' ? String(keyValue) : undefined;
    if (!key) {
      invalid += 1;
      return;
    }
    projected.push({ index, key, cursor: cursorRank(readEventJsonPath(raw, cursorPath)), raw });
  });
  // Oldest first so the cursor only ever advances over what was ingested. Items
  // without a cursor keep provider order and never advance the watermark.
  projected.sort((a, b) => compareCursorRanks(a.cursor, b.cursor) || a.index - b.index);
  return { items: projected, invalid };
}

/** Distance in seconds between two ranks of the same kind (undefined when mixed). */
function cursorGapSeconds(behind: CursorRank, ahead: CursorRank): number | undefined {
  if (behind.kind !== ahead.kind) return undefined;
  if (behind.kind === 'date') return (Number(ahead.value) - Number(behind.value)) / 1000;
  if (behind.kind === 'number') {
    // Numeric ranks carry no unit. Epoch-millisecond feeds are an order of
    // magnitude larger than Unix-second feeds, so the magnitude decides.
    const magnitude = Math.max(Math.abs(Number(behind.value)), Math.abs(Number(ahead.value)));
    return (Number(ahead.value) - Number(behind.value)) / (magnitude > 1e12 ? 1000 : 1);
  }
  return undefined;
}

function recordFailure(
  charter: DotCharter,
  trigger: DotFeedTrigger,
  state: DotFeedState,
  now: Date,
  error: string
): DotFeedState {
  return {
    ...state,
    last_poll_at: now.toISOString(),
    last_error: error.slice(0, ERROR_MAX),
    consecutive_failures: state.consecutive_failures + 1,
    stalled_since: state.stalled_since ?? now.toISOString(),
  };
}

function pushSeen(seen: string[], keys: readonly string[]): string[] {
  const next = seen.slice();
  const present = new Set(next);
  for (const key of keys) {
    if (present.has(key)) continue;
    present.add(key);
    next.push(key);
  }
  return next.slice(-DOT_FEED_SEEN_LIMIT);
}

/**
 * Poll every feed of this charter. Runs before event evaluation in the sweep so
 * freshly ingested items can wake the dot in the same pass. Never throws for a
 * provider or binding problem: the failure is durable and reported.
 */
export async function evaluateDotFeedTriggers(
  charter: DotCharter,
  deps: DotFeedDeps = {}
): Promise<DotFeedPoll[]> {
  const triggers = charter.attention.triggers.filter(
    (trigger): trigger is DotFeedTrigger => trigger.kind === 'feed'
  );
  if (triggers.length === 0) return [];
  const now = deps.now?.() ?? new Date();
  const policy =
    deps.policy ?? loadEventIntakePolicy({ tenantOverlays: true, rootDir: deps.rootDir });
  const ingest = deps.ingest ?? ingestLocalEvent;
  const polls: DotFeedPoll[] = [];

  for (const trigger of triggers) {
    const specId = feedSpecId(trigger);
    const base = { spec_id: specId, source: trigger.source, action: trigger.action };
    let state = readFeedState(charter, trigger, deps);
    if (!isPollDue(trigger, state, now)) {
      polls.push({
        ...base,
        status: 'skipped',
        observed: 0,
        ingested: 0,
        duplicate: 0,
        below_cursor: 0,
        truncated: false,
      });
      continue;
    }

    const bindingError = resolveFeedSourceBinding(trigger, charter, policy);
    if (bindingError) {
      state = recordFailure(charter, trigger, state, now, bindingError);
      writeFeedState(charter, state, deps);
      logger.warn(
        `feed ${charter.dot_id}/${specId} refused — ${bindingError} | next: declare the source for this tenant in the intake policy | evidence: ${feedStatePath(charter, specId)}`
      );
      polls.push({
        ...base,
        status: 'failed',
        observed: 0,
        ingested: 0,
        duplicate: 0,
        below_cursor: 0,
        truncated: false,
        error: bindingError,
      });
      continue;
    }
    if (!deps.serviceCall) {
      const error = 'no service port available for this feed';
      state = recordFailure(charter, trigger, state, now, error);
      writeFeedState(charter, state, deps);
      polls.push({
        ...base,
        status: 'failed',
        observed: 0,
        ingested: 0,
        duplicate: 0,
        below_cursor: 0,
        truncated: false,
        error,
      });
      continue;
    }

    // A timed-out call stays in flight; its late result is discarded by the
    // settled race (and a late rejection is already handled, so it cannot
    // crash the sweep), but the failure must say "timed out", not "bad shape".
    const FETCH_TIMEOUT = Symbol('feed-fetch-timeout');
    let raw: unknown;
    try {
      raw = await Promise.race([
        deps.serviceCall({
          service_id: trigger.service_id,
          action: trigger.action,
          params: trigger.params ?? {},
        }),
        new Promise<typeof FETCH_TIMEOUT>((resolve) =>
          setTimeout(() => resolve(FETCH_TIMEOUT), DOT_FEED_FETCH_TIMEOUT_MS)
        ),
      ]);
    } catch (error) {
      const message = boundedError(error);
      state = recordFailure(charter, trigger, state, now, message);
      writeFeedState(charter, state, deps);
      logger.warn(
        `feed ${charter.dot_id}/${specId} fetch failed — ${message} | next: check ${trigger.service_id}:${trigger.action} binding and provider health | evidence: ${feedStatePath(charter, specId)}`
      );
      polls.push({
        ...base,
        status: 'failed',
        observed: 0,
        ingested: 0,
        duplicate: 0,
        below_cursor: 0,
        truncated: false,
        error: message,
      });
      continue;
    }

    if (raw === FETCH_TIMEOUT) {
      const error = `fetch timed out after ${Math.round(DOT_FEED_FETCH_TIMEOUT_MS / 1000)}s`;
      state = recordFailure(charter, trigger, state, now, error);
      writeFeedState(charter, state, deps);
      logger.warn(
        `feed ${charter.dot_id}/${specId} fetch timed out — ${trigger.service_id}:${trigger.action} did not answer within ${Math.round(DOT_FEED_FETCH_TIMEOUT_MS / 1000)}s | next: check provider health; the in-flight call is abandoned | evidence: ${feedStatePath(charter, specId)}`
      );
      polls.push({
        ...base,
        status: 'failed',
        observed: 0,
        ingested: 0,
        duplicate: 0,
        below_cursor: 0,
        truncated: false,
        error,
      });
      continue;
    }

    const extracted = extractItems(raw, trigger);
    if (!extracted) {
      const error = `no item array at '${trigger.items_path ?? 'items'}' in the ${trigger.service_id}:${trigger.action} result`;
      state = recordFailure(charter, trigger, state, now, error);
      writeFeedState(charter, state, deps);
      polls.push({
        ...base,
        status: 'failed',
        observed: 0,
        ingested: 0,
        duplicate: 0,
        below_cursor: 0,
        truncated: false,
        error,
      });
      continue;
    }

    const { items: projected, invalid } = projectItems(extracted, trigger);
    const limit = maxItems(trigger);
    const truncated = projected.length > limit;
    const window = truncated ? projected.slice(-limit) : projected;

    // First successful poll: baseline by default. Activating a feed must never
    // wake the dot for the backlog that existed before the watcher.
    const isFirst = !state.seeded_at;
    if (isFirst && (trigger.on_first_poll ?? 'baseline') === 'baseline') {
      let newest: CursorRank | undefined;
      for (const item of window) {
        if (item.cursor && (!newest || compareCursorRanks(item.cursor, newest) > 0)) {
          newest = item.cursor;
        }
      }
      state = {
        ...state,
        cursor: rankText(newest) ?? state.cursor,
        seen: pushSeen(
          state.seen,
          window.map((item) => item.key)
        ),
        seeded_at: now.toISOString(),
        last_poll_at: now.toISOString(),
        last_success_at: now.toISOString(),
        last_error: undefined,
        consecutive_failures: 0,
        stalled_since: undefined,
      };
      writeFeedState(charter, state, deps);
      polls.push({
        ...base,
        status: 'baseline',
        observed: window.length,
        ingested: 0,
        duplicate: 0,
        below_cursor: 0,
        truncated,
      });
      continue;
    }

    const overlapS = trigger.overlap_s ?? 0;
    const watermark = state.cursor ? cursorRank(state.cursor) : undefined;
    const eventType = trigger.event_type ?? 'feed';
    const seen = new Set(state.seen);
    let cursor = state.cursor;
    let ingested = 0;
    let duplicate = 0;
    let belowCursor = 0;
    const newlySeen: string[] = [];

    for (const item of window) {
      if (seen.has(item.key)) {
        duplicate += 1;
        continue;
      }
      if (watermark && item.cursor) {
        const behind = compareCursorRanks(item.cursor, watermark);
        if (behind < 0) {
          const gapSeconds = cursorGapSeconds(item.cursor, watermark);
          const withinOverlap = overlapS > 0 && gapSeconds !== undefined && gapSeconds <= overlapS;
          if (!withinOverlap) {
            belowCursor += 1;
            continue;
          }
        }
      }
      try {
        const result = ingest({
          source: trigger.source,
          body:
            typeof item.raw === 'object' ? (item.raw as Record<string, unknown>) : String(item.raw),
          type: eventType,
          deliveryId: `feed:${specId}:${item.key}`,
          policy,
          rootDir: deps.rootDir,
          now,
        });
        if (result.status === 'accepted') ingested += 1;
        else duplicate += 1;
        newlySeen.push(item.key);
      } catch (error) {
        // One malformed item must not lose the cursor position for the rest.
        logger.warn(
          `feed ${charter.dot_id}/${specId} item ${item.key} rejected — ${boundedError(error)} | next: inspect the preset payload shape | evidence: ${feedStatePath(charter, specId)}`
        );
      }
      if (compareCursorRanks(item.cursor, cursorRank(cursor)) > 0) {
        cursor = rankText(item.cursor);
      }
    }

    state = {
      ...state,
      cursor,
      seen: pushSeen(state.seen, newlySeen),
      seeded_at: state.seeded_at ?? now.toISOString(),
      last_poll_at: now.toISOString(),
      last_success_at: now.toISOString(),
      last_error: undefined,
      consecutive_failures: 0,
      stalled_since: undefined,
      ingested: state.ingested + ingested,
      duplicates: state.duplicates + duplicate,
      capped_polls: state.capped_polls + (truncated ? 1 : 0),
    };
    writeFeedState(charter, state, deps);
    if (invalid > 0) {
      logger.debug(
        `feed ${charter.dot_id}/${specId} skipped ${invalid} item(s) without '${trigger.item_id_path ?? 'id'}'`
      );
    }
    polls.push({
      ...base,
      status: 'polled',
      observed: window.length,
      ingested,
      duplicate,
      below_cursor: belowCursor,
      truncated,
    });
  }
  return polls;
}

// ---------------------------------------------------------------------------
// coverage (read-only)
// ---------------------------------------------------------------------------

/**
 * Coverage is an observation, not a backlog count: a feed cannot know what the
 * provider did not return. What it can prove is whether the last poll
 * succeeded, when, and whether the cursor is advancing.
 */
export function readDotFeedCoverage(
  charter: DotCharter,
  deps: DotRuntimeDeps = {},
  now = deps.now?.() ?? new Date()
): DotFeedCoverage[] {
  const triggers = charter.attention.triggers.filter(
    (trigger): trigger is DotFeedTrigger => trigger.kind === 'feed'
  );
  return triggers.map((trigger) => {
    const state = readFeedState(charter, trigger, deps);
    const interval = pollIntervalMs(trigger, state);
    const lastPoll = state.last_poll_at ? Date.parse(state.last_poll_at) : Number.NaN;
    const lastSuccess = state.last_success_at ? Date.parse(state.last_success_at) : Number.NaN;
    const stallsByFailure = state.consecutive_failures >= DOT_FEED_STALL_AFTER_FAILURES;
    const stallsBySilence =
      Number.isFinite(lastSuccess) &&
      now.getTime() - lastSuccess > everyS(trigger) * 3 * 1000 + 60_000;
    let health: DotFeedCoverage['state'];
    if (stallsByFailure || stallsBySilence) health = 'stalled';
    else if (state.consecutive_failures > 0) health = 'failing';
    else if (!state.seeded_at) health = 'never_polled';
    else if (!state.last_success_at) health = 'baseline';
    else health = 'healthy';
    const detail =
      health === 'stalled'
        ? `${state.consecutive_failures} consecutive failure(s); last success ${state.last_success_at ?? 'never'} — this feed is blind until it recovers`
        : health === 'failing'
          ? `last poll failed: ${state.last_error ?? 'unknown error'}`
          : health === 'never_polled'
            ? 'no successful poll yet'
            : health === 'baseline'
              ? 'baseline established; waiting for new items'
              : `last success ${state.last_success_at}${state.cursor ? ` at cursor ${state.cursor}` : ''}`;
    return {
      spec_id: state.spec_id,
      source: trigger.source,
      service_id: trigger.service_id,
      action: trigger.action,
      event_type: trigger.event_type ?? 'feed',
      state: health,
      ...(state.cursor ? { cursor: state.cursor } : {}),
      ...(state.seeded_at ? { seeded_at: state.seeded_at } : {}),
      ...(state.last_poll_at ? { last_poll_at: state.last_poll_at } : {}),
      ...(state.last_success_at ? { last_success_at: state.last_success_at } : {}),
      ...(Number.isFinite(lastPoll)
        ? { next_poll_at: new Date(lastPoll + interval).toISOString() }
        : {}),
      consecutive_failures: state.consecutive_failures,
      ...(state.last_error ? { last_error: state.last_error } : {}),
      ingested: state.ingested,
      duplicates: state.duplicates,
      capped_polls: state.capped_polls,
      detail: detail.slice(0, DETAIL_MAX),
    };
  });
}
