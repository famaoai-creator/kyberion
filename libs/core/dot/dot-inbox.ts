import { runtimeStatePath } from '../foundation/runtime-state-roots.js';
/**
 * dot-inbox producer — the write side of the durable wake lane.
 *
 * `evaluateDotTriggersDue` reads `active/shared/runtime/dot-inbox.jsonl` for
 * `wake` charter triggers: a row addressed to `dot_id` wakes that one dot, a
 * row without `dot_id` wakes every charter declaring the row's `channel`.
 * Before this module existed, only tests wrote the lane — any producer that
 * wants to wake a resident dot appends through here.
 *
 * The lane is a notification surface, not a content transport: `text` is
 * truncated and `payload` is bounded so producers cannot smuggle a payload
 * document through the wake path.
 */

import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { appendJsonLine, parseSafeJsonInput, readJsonLines } from '../foundation/json.js';
import { withLockSync } from '../foundation/lock-utils.js';
import { createLogger } from '../logger.js';
import { pathResolver } from '../path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReadFile,
  safeStat,
  safeReadFileTail,
  safeWriteFile,
} from '../secure-io.js';
import type { DotCharter, DotTrigger } from './dot-charter.js';
import { isFrontDeskDiagnosticDot, listDotCharters } from './dot-charter.js';

const logger = createLogger('dot-inbox');

export const DOT_INBOX_PATH = 'active/shared/runtime/dot-inbox.jsonl';

/**
 * Channels a charter `wake` trigger may declare — kept in sync with the
 * `channels` enum in `knowledge/product/schemas/dot-charter.schema.json`.
 */
export const DOT_WAKE_CHANNELS = [
  'slack',
  'telegram',
  'discord',
  'imessage',
  'surface',
  'inbox',
] as const;
export type DotWakeChannel = (typeof DOT_WAKE_CHANNELS)[number];

export function isDotWakeChannel(value: string): value is DotWakeChannel {
  return (DOT_WAKE_CHANNELS as readonly string[]).includes(value);
}

/** Bounded so the wake lane stays a pointer, never the payload. */
const MAX_INBOX_TEXT_CHARS = 2_000;
const MAX_INBOX_PAYLOAD_BYTES = 4 * 1024;

/**
 * Receipt lookup window: only the newest bytes of the shared inbox are
 * scanned for an idempotent retry. A producer retry is near-term, so a key
 * older than this window (behind ≥ 4 MiB of newer wake rows) counts as a new
 * delivery — the scan under the global lock stays O(window), not O(inbox).
 */
export const DOT_INBOX_RECEIPT_SCAN_BYTES = 4 * 1024 * 1024;

/**
 * Newest-first scan for a parseable row carrying the same delivery identity.
 * The inbox is shared by every tenant: an unparseable (torn) line is skipped
 * and counted — it cannot be attributed to a key, so it is never treated as a
 * receipt and never blocks another tenant's idempotent report. A parseable
 * matching row is still the receipt, even when it later fails validation.
 */
function findDotInboxReceipt(
  filePath: string,
  matches: (row: AppendedDotInboxEntry) => boolean
): AppendedDotInboxEntry | undefined {
  const tail = safeReadFileTail(filePath, DOT_INBOX_RECEIPT_SCAN_BYTES);
  const lines = tail.buffer.toString('utf8').split(/\r?\n/);
  // A truncated window starts mid-line; that fragment is not a row.
  if (tail.truncated) lines.shift();
  let malformed = 0;
  let found: AppendedDotInboxEntry | undefined;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    let row: AppendedDotInboxEntry;
    try {
      row = parseSafeJsonInput(line, 'dot inbox row') as AppendedDotInboxEntry;
    } catch {
      malformed += 1;
      continue;
    }
    if (row && typeof row === 'object' && matches(row)) {
      found = row;
      break;
    }
  }
  if (malformed > 0) {
    logger.warn(
      `dot inbox has ${malformed} malformed line(s) in the receipt window — skipped | next: inspect the torn rows; idempotent delivery continues | evidence: ${filePath}`
    );
  }
  return found;
}

export interface DotInboxEntryInput {
  /** Omit for broadcast: every charter declaring `channel` wakes. */
  dot_id?: string;
  channel: string;
  text?: string;
  /** Small routing metadata only — never secrets or document bodies. */
  payload?: Record<string, unknown>;
  /** Free-form producer tag, e.g. 'channel-turn', 'state-probe', 'cli'. */
  source?: string;
  /** Trusted producer delivery identity, scoped to dot/channel/source. */
  idempotency_key?: string;
}

export interface DotInboxAppendDeps {
  rootDir?: string;
  now?: () => Date;
  /** Test seam: override the byte threshold that gates tombstone compaction. */
  compactMinBytes?: number;
}

export interface AppendedDotInboxEntry extends DotInboxEntryInput {
  channel: DotWakeChannel;
  enqueued_at: string;
}

/**
 * Append one wake row to the dot inbox. Rows are validated and bounded at
 * write time so the sweep can trust what it reads.
 */
export function appendDotInboxEntry(
  input: DotInboxEntryInput,
  deps: DotInboxAppendDeps = {}
): AppendedDotInboxEntry {
  const channel = String(input.channel || '').trim();
  if (!isDotWakeChannel(channel)) {
    throw new Error(
      `[DOT_INBOX] channel must be one of ${DOT_WAKE_CHANNELS.join(', ')} (received '${channel}')`
    );
  }
  const dotId = input.dot_id?.trim();
  const idempotencyKey = input.idempotency_key;
  if (
    idempotencyKey !== undefined &&
    (typeof idempotencyKey !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/.test(idempotencyKey))
  ) {
    throw new Error('[DOT_INBOX] idempotency_key must be a bounded ASCII delivery identity');
  }
  const payloadText = input.payload === undefined ? undefined : JSON.stringify(input.payload);
  if (
    payloadText !== undefined &&
    Buffer.byteLength(payloadText, 'utf8') > MAX_INBOX_PAYLOAD_BYTES
  ) {
    throw new Error('[DOT_INBOX] payload exceeds 4KB — pass a reference, not the content');
  }
  const text = input.text?.slice(0, MAX_INBOX_TEXT_CHARS);
  const entry: AppendedDotInboxEntry = {
    channel,
    ...(dotId ? { dot_id: dotId } : {}),
    ...(text?.trim() ? { text } : {}),
    ...(input.payload !== undefined ? { payload: input.payload } : {}),
    ...(input.source?.trim() ? { source: input.source.trim() } : {}),
    ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    enqueued_at: (deps.now?.() ?? new Date()).toISOString(),
  };
  const filePath = assertSafeRepositoryPath(
    path.join(deps.rootDir ?? pathResolver.rootDir(), DOT_INBOX_PATH),
    { allowMissingLeaf: true }
  );
  safeMkdir(path.dirname(filePath), { recursive: true });
  if (idempotencyKey) {
    // The inbox row is the delivery receipt. Keep lookup and append under one
    // file-scoped lock so a retry after an uncertain append returns that receipt
    // rather than emitting a second wake. A parseable matching row with an
    // invalid timestamp is unreadable evidence and still fails closed.
    const lock = `dot-inbox-${createHash('sha256').update(filePath).digest('hex').slice(0, 24)}`;
    const result = withLockSync(lock, () => {
      let exists = true;
      try {
        safeLstat(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false;
        else throw error;
      }
      const prior = exists
        ? findDotInboxReceipt(
            filePath,
            (row) =>
              row.idempotency_key === idempotencyKey &&
              row.dot_id === entry.dot_id &&
              row.channel === entry.channel &&
              row.source === entry.source
          )
        : undefined;
      if (prior) {
        if (
          typeof prior.enqueued_at !== 'string' ||
          !Number.isFinite(Date.parse(prior.enqueued_at))
        ) {
          throw new Error('[DOT_INBOX] existing delivery receipt has an invalid timestamp');
        }
        return prior;
      }
      appendJsonLine(filePath, entry);
      return entry;
    });
    const appended = result === entry;
    if (appended) maybeCompactDotInbox(filePath, deps);
    return result;
  }
  appendJsonLine(filePath, entry);
  maybeCompactDotInbox(filePath, deps);
  return entry;
}

/**
 * Size-gated opportunistic compaction — cheap stat on every append, real work
 * only past the threshold. Any failure logs and never blocks the append.
 */
function maybeCompactDotInbox(filePath: string, deps: DotInboxAppendDeps): void {
  try {
    if (safeStat(filePath).size < (deps.compactMinBytes ?? DOT_INBOX_COMPACT_MIN_BYTES)) return;
    compactDotInbox(deps);
  } catch (error) {
    logger.warn(
      `[DOT_INBOX] opportunistic compaction failed — lane stays append-only | next: inspect the file | evidence: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// ---------------------------------------------------------------------------
// wake-key + match contract shared with the consumer (dot-runtime)
// ---------------------------------------------------------------------------

/**
 * Executor report-back marker — canonical producer id for inbox rows that
 * carry `payload.report_from`. Defined here (not dot-runtime) so the consumer
 * predicate and the compactor share one source without an import cycle;
 * dot-runtime re-exports it for existing callers.
 */
export const DOT_EXECUTOR_REPORT_SOURCE_VALUE = 'dot-executor';

/** Wake trigger key — MUST stay identical to the consumer's derivation:
 *  `${lineIndex}:${rawLine}` hashed. Line index is 1-based over raw split
 *  lines (blank lines count) because readJsonLines maps `index + 1`. */
export function dotInboxWakeKey(lineIndex: number, rawLine: string): string {
  return `wake:${createHash('sha256')
    .update(`${lineIndex}:${rawLine}`)
    .digest('hex')
    .slice(0, 16)}`;
}

/**
 * Would this inbox row wake this charter? Single source of the consumer's
 * predicate: an addressed row needs handoff-source acceptance or the
 * executor report-back marker or a declared wake channel; an unaddressed
 * row needs its channel declared.
 */
export function dotInboxRowWakesCharter(
  row: { dot_id?: string; channel?: string; payload?: Record<string, unknown> },
  charter: DotCharter
): boolean {
  const declaredChannels = charter.attention.triggers
    .filter((t): t is Extract<DotTrigger, { kind: 'wake' }> => t.kind === 'wake')
    .flatMap((t) => t.channels);
  const handoffSources = charter.team?.accepts_handoffs_from ?? [];
  const payload =
    row.payload && typeof row.payload === 'object'
      ? (row.payload as Record<string, unknown>)
      : undefined;
  const handoffFrom = payload?.handoff_from;
  const addressed =
    row.dot_id === charter.dot_id &&
    (typeof handoffFrom === 'string'
      ? handoffSources.includes(handoffFrom)
      : payload?.report_from === DOT_EXECUTOR_REPORT_SOURCE_VALUE || declaredChannels.length > 0);
  const channelHit =
    !row.dot_id && typeof row.channel === 'string' && declaredChannels.includes(row.channel);
  return addressed || channelHit;
}

// ---------------------------------------------------------------------------
// tombstone compaction
// ---------------------------------------------------------------------------

export const DOT_INBOX_COMPACT_MIN_BYTES = 4 * 1024 * 1024;
/** Orphaned rows (match no current charter) tombstone only past this age. */
export const DOT_INBOX_ORPHAN_TOMBSTONE_MS = 30 * 24 * 60 * 60 * 1000;
const DOT_INBOX_TOMBSTONE = '{"tombstone":true}';
export const DOT_WAKE_LEDGER_REL = runtimeStatePath('dot.wakeLedger').logicalPath;

export interface DotInboxCompactResult {
  tombstoned: number;
  scanned: number;
  bytes_before: number;
  bytes_after: number;
}

/**
 * Positional-key-safe compaction: consumed rows are replaced IN PLACE with a
 * tombstone line, so the file's line count — and therefore every surviving
 * row's `__index` — never changes and no wake key is ever re-derived. A row
 * tombstones only when every charter it could wake already consumed its key
 * (delivered-and-not-retained or rejected in the wake ledger), or when it
 * matches no charter and is older than the orphan window. Serialized under
 * the same inbox lock as appenders; a post-write audit re-reads the file and
 * rolls back if surviving lines moved.
 */
export function compactDotInbox(deps: DotInboxAppendDeps = {}): DotInboxCompactResult {
  const empty = { tombstoned: 0, scanned: 0, bytes_before: 0, bytes_after: 0 };
  const filePath = assertSafeRepositoryPath(
    path.join(deps.rootDir ?? pathResolver.rootDir(), DOT_INBOX_PATH),
    { allowMissingLeaf: true }
  );
  const compactMinBytes = deps.compactMinBytes ?? DOT_INBOX_COMPACT_MIN_BYTES;
  if (!safeExistsSync(filePath)) return empty;

  const lockId = `dot-inbox-${createHash('sha256').update(filePath).digest('hex').slice(0, 24)}`;
  return withLockSync(lockId, () => {
    const bytesBefore = safeStat(filePath).size;
    if (bytesBefore < compactMinBytes) return { ...empty, bytes_before: bytesBefore };

    const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
    // 1-based raw indices mirror the consumer's __index exactly — blanks count.
    const lines = raw.split(/\r?\n/);
    const charters = listDotCharters(deps.rootDir ?? pathResolver.rootDir(), { status: 'active' })
      .map((c) => ('charter' in c ? (c as { charter: DotCharter }).charter : (c as DotCharter)))
      .filter((c) => !isFrontDeskDiagnosticDot(c));

    // Terminal outcomes per dot — the same predicate the due-checker consumes.
    const ledgerPath = assertSafeRepositoryPath(
      path.join(deps.rootDir ?? pathResolver.rootDir(), DOT_WAKE_LEDGER_REL),
      { allowMissingLeaf: true }
    );
    const consumedByDot = new Map<string, Set<string>>();
    if (safeExistsSync(ledgerPath)) {
      for (const row of readJsonLines<Record<string, unknown>>(ledgerPath, {
        onMalformed: 'skip',
      })) {
        const consumed =
          (row.outcome === 'delivered' && !row.trigger_retained) || row.outcome === 'rejected';
        if (!consumed || typeof row.dot_id !== 'string' || typeof row.trigger_key !== 'string')
          continue;
        let set = consumedByDot.get(row.dot_id);
        if (!set) consumedByDot.set(row.dot_id, (set = new Set()));
        set.add(row.trigger_key);
      }
    }

    const nowMs = (deps.now?.() ?? new Date()).getTime();
    const tombstonedIdx = new Set<number>();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line || !line.trim() || line === DOT_INBOX_TOMBSTONE) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // unparseable rows are evidence — never tombstone them
      }
      const matched = charters.filter((c) => dotInboxRowWakesCharter(parsed as never, c));
      if (matched.length === 0) {
        const enq = Date.parse(String(parsed.enqueued_at ?? ''));
        if (Number.isFinite(enq) && nowMs - enq >= DOT_INBOX_ORPHAN_TOMBSTONE_MS)
          tombstonedIdx.add(i);
        continue;
      }
      const key = dotInboxWakeKey(i + 1, line);
      if (matched.every((c) => consumedByDot.get(c.dot_id)?.has(key))) tombstonedIdx.add(i);
    }
    if (tombstonedIdx.size === 0)
      return {
        tombstoned: 0,
        scanned: lines.length,
        bytes_before: bytesBefore,
        bytes_after: bytesBefore,
      };

    const rewritten = lines
      .map((l, i) => (tombstonedIdx.has(i) ? DOT_INBOX_TOMBSTONE : l))
      .join('\n');
    safeWriteFile(filePath, rewritten.endsWith('\n') ? rewritten : `${rewritten}\n`);

    // Audit: surviving non-tombstone lines must sit at identical indices —
    // any drift means a key re-derivation happened; restore the original.
    const after = (safeReadFile(filePath, { encoding: 'utf8' }) as string).split(/\r?\n/);
    const drift =
      after.length !== lines.length ||
      lines.some((l, i) => !tombstonedIdx.has(i) && after[i] !== l);
    if (drift) {
      safeWriteFile(filePath, raw);
      throw new Error('[DOT_INBOX] tombstone audit detected positional drift — rolled back');
    }
    const bytesAfter = safeStat(filePath).size;
    logger.info(
      `[DOT_INBOX] tombstoned ${tombstonedIdx.size} row(s): ${bytesBefore} -> ${bytesAfter} bytes (positions preserved)`
    );
    return {
      tombstoned: tombstonedIdx.size,
      scanned: lines.length,
      bytes_before: bytesBefore,
      bytes_after: bytesAfter,
    };
  });
}
