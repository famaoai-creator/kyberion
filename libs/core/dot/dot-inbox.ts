import { runtimeStatePath } from '../foundation/runtime-state-roots.js';
import { type EventScopeInput } from '../event-scope.js';
import { assertScopeContext } from '../scope-context-validation.js';
import { dotStatePath } from './dot-state-paths.js';
/**
 * dot-inbox producer — the write side of the durable wake lane.
 *
 * `evaluateDotTriggersDue` reads the charter's exact tier/tenant/owner lane.
 * A row addressed to `dot_id` wakes that dot only inside its matching scope;
 * an explicit public row may notify matching public-channel subscribers.
 * Before this module existed, only tests wrote the lane — any producer that
 * wants to wake a resident dot appends through here.
 *
 * The lane is a notification surface, not a content transport: `text` is
 * truncated and `payload` is bounded so producers cannot smuggle a payload
 * document through the wake path.
 */

import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { appendJsonLine, parseSafeJsonInput } from '../foundation/json.js';
import {
  fileEndsWithNewline,
  streamJsonLines,
  streamTextLines,
  type JsonlRawLine,
} from '../jsonl-read.js';
import { withLockSync } from '../foundation/lock-utils.js';
import { createLogger } from '../logger.js';
import { pathResolver } from '../path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeAppendFileSync,
  safeMkdir,
  safeMoveSync,
  safeStat,
  safeReadFileTail,
  safeUnlinkSync,
} from '../secure-io.js';
import type { DotCharter, DotTrigger } from './dot-charter.js';
import { isFrontDeskDiagnosticDot, listDotCharters } from './dot-charter.js';

const logger = createLogger('dot-inbox');

export const DOT_INBOX_PATH = 'active/shared/runtime/dot-inbox.jsonl';

/** Public notifications retain the legacy lane; private content never enters it. */
export type DotInboxScope = EventScopeInput & { owner_nhi?: string };
function inboxScope(scope: DotInboxScope): DotCharter['scope'] {
  const canonical = assertScopeContext(scope, { allowShared: true });
  if (canonical.tier === 'personal' && !scope.owner_nhi?.trim())
    throw new Error('[DOT_PERSONAL_OWNER] private inbox requires owner_nhi');
  return { ...canonical, ...(scope.owner_nhi ? { owner_nhi: scope.owner_nhi } : {}) };
}
export function dotInboxPath(scope: DotInboxScope = { tier: 'public' }): string {
  const canonical = inboxScope(scope);
  if (canonical.tier === 'public' && !canonical.tenant_slug && !canonical.organization_id)
    return DOT_INBOX_PATH;
  return dotStatePath({ scope: canonical }, 'inbox.jsonl');
}

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
  /** Trusted producer scope, never inferred from an untrusted message payload. */
  scope?: DotInboxScope;
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
  scope?: DotInboxScope;
  rootDir?: string;
  now?: () => Date;
  /** Test seam: override the byte threshold that gates tombstone compaction. */
  compactMinBytes?: number;
  /** Test seam: range-read chunk size for the streamed compaction. */
  chunkBytes?: number;
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
  if (!input.scope)
    throw new Error(
      '[DOT_INBOX_SCOPE_REQUIRED] declare trusted scope or an explicit public notification'
    );
  const scope = inboxScope(input.scope);
  const entry: AppendedDotInboxEntry = {
    scope,
    channel,
    ...(dotId ? { dot_id: dotId } : {}),
    ...(text?.trim() ? { text } : {}),
    ...(input.payload !== undefined ? { payload: input.payload } : {}),
    ...(input.source?.trim() ? { source: input.source.trim() } : {}),
    ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    enqueued_at: (deps.now?.() ?? new Date()).toISOString(),
  };
  const filePath = assertSafeRepositoryPath(
    path.join(deps.rootDir ?? pathResolver.rootDir(), dotInboxPath(scope)),
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
    if (appended) maybeCompactDotInbox(filePath, { ...deps, scope });
    return result;
  }
  appendJsonLine(filePath, entry);
  maybeCompactDotInbox(filePath, { ...deps, scope });
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
 *  lines (blank lines count, `\r\n` stripped) — the numbering `readJsonLines`
 *  used (`index + 1`) and `streamJsonLines` / `streamTextLines` keep. */
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
  row: {
    dot_id?: string;
    channel?: string;
    payload?: Record<string, unknown>;
    scope?: DotInboxScope;
  },
  charter: DotCharter
): boolean {
  // Legacy global rows have no trustworthy origin. Do not reinterpret private
  // historical content as public merely because its producer omitted scope.
  if (!row.scope) return false;
  let scope: DotCharter['scope'];
  try {
    scope = inboxScope(row.scope ?? { tier: 'public' });
  } catch {
    return false;
  }
  if (
    scope.tier !== charter.scope.tier ||
    (scope.tenant_slug ?? '') !== (charter.scope.tenant_slug ?? '') ||
    (scope.organization_id ?? '') !== (charter.scope.organization_id ?? '') ||
    (scope.project_id ?? '') !== (charter.scope.project_id ?? '')
  )
    return false;
  if (scope.tier === 'personal' && scope.owner_nhi !== charter.scope.owner_nhi) return false;
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
    path.join(deps.rootDir ?? pathResolver.rootDir(), dotInboxPath(deps.scope)),
    { allowMissingLeaf: true }
  );
  const compactMinBytes = deps.compactMinBytes ?? DOT_INBOX_COMPACT_MIN_BYTES;
  if (!safeExistsSync(filePath)) return empty;

  const lockId = `dot-inbox-${createHash('sha256').update(filePath).digest('hex').slice(0, 24)}`;
  return withLockSync(lockId, () => {
    const bytesBefore = safeStat(filePath).size;
    if (bytesBefore < compactMinBytes) return { ...empty, bytes_before: bytesBefore };

    // MSN-STORE-BOUNDS-2 (P1): streamed, never a whole-file read, so the
    // inbox's size cannot stop its own compaction. Forward line numbers are
    // 1-based and count blank lines — exactly the old `split(/\r?\n/)` index
    // + 1 that the consumer's `__index` (and so every wake key) uses.
    const scanOptions = { chunkBytes: deps.chunkBytes };
    let oversized = false;
    const scan = (file: string): Generator<JsonlRawLine> =>
      streamTextLines(file, {
        ...scanOptions,
        onOversized: () => {
          oversized = true;
        },
      });
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
      for (const row of streamJsonLines<Record<string, unknown>>(ledgerPath, {
        ...scanOptions,
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
    const tombstonedLines = new Set<number>();
    let lineCount = 0;
    for (const { text: line, lineNumber } of scan(filePath)) {
      lineCount = lineNumber;
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
          tombstonedLines.add(lineNumber);
        continue;
      }
      const key = dotInboxWakeKey(lineNumber, line);
      if (matched.every((c) => consumedByDot.get(c.dot_id)?.has(key))) {
        tombstonedLines.add(lineNumber);
      }
    }
    // `scanned` keeps the old split-based count (the segment after the last
    // newline counted even when empty).
    const scanned = lineCount + (fileEndsWithNewline(filePath) ? 1 : 0);
    if (oversized) {
      // A line over the per-line guard cannot be copied without buffering it;
      // compaction would lose it, so leave the file untouched.
      logger.warn(
        `[DOT_INBOX] compaction skipped for ${filePath} — a line exceeds the per-line read guard | next: inspect the writer that produced it | evidence: ${bytesBefore} bytes`
      );
      return { tombstoned: 0, scanned, bytes_before: bytesBefore, bytes_after: bytesBefore };
    }
    if (tombstonedLines.size === 0)
      return {
        tombstoned: 0,
        scanned,
        bytes_before: bytesBefore,
        bytes_after: bytesBefore,
      };

    // Stream the rewrite into a sibling staging file, audit it against the
    // live file, then rename it over the live file (still under the lock).
    const staging = `${filePath}.compacting-${process.pid}`;
    try {
      safeUnlinkSync(staging);
      let batch = '';
      for (const { text, lineNumber } of scan(filePath)) {
        batch += `${tombstonedLines.has(lineNumber) ? DOT_INBOX_TOMBSTONE : text}\n`;
        if (batch.length >= 1024 * 1024) {
          safeAppendFileSync(staging, batch);
          batch = '';
        }
      }
      safeAppendFileSync(staging, batch);

      // Audit: surviving non-tombstone lines must sit at identical line
      // numbers — any drift means a key would be re-derived; keep the original.
      const live = scan(filePath);
      let drift = false;
      for (const rewritten of scan(staging)) {
        const original = live.next();
        if (original.done || original.value.lineNumber !== rewritten.lineNumber) {
          drift = true;
          break;
        }
        const expected = tombstonedLines.has(rewritten.lineNumber)
          ? DOT_INBOX_TOMBSTONE
          : original.value.text;
        if (rewritten.text !== expected) {
          drift = true;
          break;
        }
      }
      if (!live.next().done) drift = true;
      live.return(undefined);
      if (drift || oversized) {
        throw new Error('[DOT_INBOX] tombstone audit detected positional drift — rolled back');
      }
      safeMoveSync(staging, filePath);
    } finally {
      try {
        safeUnlinkSync(staging);
      } catch {
        // best-effort staging cleanup
      }
    }
    const bytesAfter = safeStat(filePath).size;
    logger.info(
      `[DOT_INBOX] tombstoned ${tombstonedLines.size} row(s): ${bytesBefore} -> ${bytesAfter} bytes (positions preserved)`
    );
    return {
      tombstoned: tombstonedLines.size,
      scanned,
      bytes_before: bytesBefore,
      bytes_after: bytesAfter,
    };
  });
}
