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
import { appendJsonLine, parseSafeJsonInput } from '../foundation/json.js';
import { withLockSync } from '../foundation/lock-utils.js';
import { createLogger } from '../logger.js';
import { pathResolver } from '../path-resolver.js';
import { assertSafeRepositoryPath, safeLstat, safeMkdir, safeReadFileTail } from '../secure-io.js';

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
    return withLockSync(lock, () => {
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
  }
  appendJsonLine(filePath, entry);
  return entry;
}
