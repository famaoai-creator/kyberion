import { buildUserFacingError } from './error-classifier.js';
import { renderVocabularyText } from './ux-vocabulary.js';
import { logger } from './core.js';

/**
 * Shared error/empty-reply presentation for text bridges (UX-01 Task 3).
 *
 * Bridges must never leave the user in silence: a handler failure or an empty
 * agent reply always produces a deterministic, vocabulary-driven message.
 * Raw err.message / stack traces stay in the logs — they are never posted.
 */

export interface BridgeErrorReplyOptions {
  locale?: string;
  surface?: string;
  traceId?: string;
}

export function buildBridgeErrorReplyText(
  err: unknown,
  opts: BridgeErrorReplyOptions = {}
): string {
  const envelope = buildUserFacingError(err, opts);
  return [envelope.title, envelope.body, envelope.nextAction].filter(Boolean).join('\n');
}

export function buildBridgeEmptyReplyText(opts: { locale?: string } = {}): string {
  return [
    renderVocabularyText('empty_reply_body', opts.locale),
    renderVocabularyText('empty_reply_next_step', opts.locale),
  ]
    .filter(Boolean)
    .join('\n');
}

const DEFAULT_ERROR_POST_INTERVAL_MS = 60_000;
const lastErrorPostAtByConversation = new Map<string, number>();

/**
 * Rate limit for error postings: at most one error message per conversation
 * per interval, so retry storms do not spam the user (UX-01 リスクと注意).
 * Returns true when the caller should post now (and records the attempt).
 */
export function shouldPostBridgeError(
  conversationKey: string,
  nowMs: number = Date.now(),
  intervalMs: number = DEFAULT_ERROR_POST_INTERVAL_MS
): boolean {
  const last = lastErrorPostAtByConversation.get(conversationKey);
  if (last !== undefined && nowMs - last < intervalMs) return false;
  lastErrorPostAtByConversation.set(conversationKey, nowMs);
  // Bounded memory: drop oldest entries past a sane cap.
  if (lastErrorPostAtByConversation.size > 1000) {
    const oldestKey = lastErrorPostAtByConversation.keys().next().value;
    if (oldestKey !== undefined) lastErrorPostAtByConversation.delete(oldestKey);
  }
  return true;
}

export function resetBridgeErrorRateLimiter(): void {
  lastErrorPostAtByConversation.clear();
}

/**
 * Convenience wrapper: post an error reply through `post` unless rate-limited.
 * The posting failure itself is only logged — never rethrown.
 */
export async function postBridgeError(params: {
  conversationKey: string;
  err: unknown;
  post: (text: string) => Promise<unknown>;
  locale?: string;
  surface?: string;
  traceId?: string;
}): Promise<boolean> {
  if (!shouldPostBridgeError(params.conversationKey)) return false;
  const text = buildBridgeErrorReplyText(params.err, {
    locale: params.locale,
    surface: params.surface,
    traceId: params.traceId,
  });
  try {
    await params.post(text);
    return true;
  } catch (postErr) {
    const message = postErr instanceof Error ? postErr.message : String(postErr);
    logger.warn(
      `[bridge-error-reply] failed to deliver error reply for ${params.conversationKey}: ${message}`
    );
    return false;
  }
}

/**
 * Discord-style safe chunking: split text into chunks of at most maxLen,
 * preferring newline boundaries and never splitting inside a code fence.
 */
export function chunkBridgeMessage(text: string, maxLen = 1900): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf('\n', maxLen);
    if (cut <= 0) cut = maxLen;
    let chunk = remaining.slice(0, cut);
    // Keep code fences balanced within each chunk: if a chunk opens a fence
    // without closing it, close it here and reopen in the next chunk.
    const fenceCount = (chunk.match(/```/g) || []).length;
    let reopenFence = false;
    if (fenceCount % 2 === 1) {
      chunk += '\n```';
      reopenFence = true;
    }
    chunks.push(chunk);
    remaining = (reopenFence ? '```\n' : '') + remaining.slice(cut).replace(/^\n/, '');
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
