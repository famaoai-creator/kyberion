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
import { appendJsonLine } from '../foundation/json.js';
import { pathResolver } from '../path-resolver.js';
import { assertSafeRepositoryPath, safeMkdir } from '../secure-io.js';

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

export interface DotInboxEntryInput {
  /** Omit for broadcast: every charter declaring `channel` wakes. */
  dot_id?: string;
  channel: string;
  text?: string;
  /** Small routing metadata only — never secrets or document bodies. */
  payload?: Record<string, unknown>;
  /** Free-form producer tag, e.g. 'channel-turn', 'state-probe', 'cli'. */
  source?: string;
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
    enqueued_at: (deps.now?.() ?? new Date()).toISOString(),
  };
  const filePath = assertSafeRepositoryPath(
    path.join(deps.rootDir ?? pathResolver.rootDir(), DOT_INBOX_PATH),
    { allowMissingLeaf: true }
  );
  safeMkdir(path.dirname(filePath), { recursive: true });
  appendJsonLine(filePath, entry);
  return entry;
}
