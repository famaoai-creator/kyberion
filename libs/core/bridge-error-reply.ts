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

export type SurfaceMessageFormat = 'plain' | 'markdown' | 'mrkdwn';

export interface SurfaceCapabilityManifest {
  surface: string;
  maxMessageLength: number;
  messageLengthUnit: 'utf16';
  format: SurfaceMessageFormat;
  supportsChunking: boolean;
  supportsTyping: boolean;
  supportsButtons: boolean;
}

const SURFACE_CAPABILITIES: Record<string, SurfaceCapabilityManifest> = {
  slack: {
    surface: 'slack',
    maxMessageLength: 40_000,
    messageLengthUnit: 'utf16',
    format: 'mrkdwn',
    supportsChunking: true,
    supportsTyping: false,
    supportsButtons: true,
  },
  telegram: {
    surface: 'telegram',
    maxMessageLength: 4_096,
    messageLengthUnit: 'utf16',
    format: 'markdown',
    supportsChunking: true,
    supportsTyping: true,
    supportsButtons: true,
  },
  discord: {
    surface: 'discord',
    maxMessageLength: 1_900,
    messageLengthUnit: 'utf16',
    format: 'markdown',
    supportsChunking: true,
    supportsTyping: true,
    supportsButtons: true,
  },
  imessage: {
    surface: 'imessage',
    maxMessageLength: 20_000,
    messageLengthUnit: 'utf16',
    format: 'plain',
    supportsChunking: true,
    supportsTyping: false,
    supportsButtons: false,
  },
};

const UNKNOWN_SURFACE_CAPABILITY: SurfaceCapabilityManifest = {
  surface: 'unknown',
  maxMessageLength: 1_900,
  messageLengthUnit: 'utf16',
  format: 'plain',
  supportsChunking: true,
  supportsTyping: false,
  supportsButtons: false,
};

export function getSurfaceCapability(surface: string): SurfaceCapabilityManifest {
  const normalized = String(surface || '')
    .trim()
    .toLowerCase();
  const capability = SURFACE_CAPABILITIES[normalized] || UNKNOWN_SURFACE_CAPABILITY;
  return { ...capability, surface: normalized || capability.surface };
}

export function listSurfaceCapabilities(): SurfaceCapabilityManifest[] {
  return Object.values(SURFACE_CAPABILITIES).map((capability) => ({ ...capability }));
}

/** Split text using the receiving surface's declared message limit. */
export function chunkSurfaceMessage(
  text: string,
  surface: string,
  maxLenOverride?: number
): string[] {
  const capability = getSurfaceCapability(surface);
  return chunkBridgeMessage(text, maxLenOverride || capability.maxMessageLength);
}

export function isSurfaceFormatError(error: unknown, options: { surface?: string } = {}): boolean {
  const candidate = error as { message?: unknown; status?: unknown; code?: unknown };
  const message = String(candidate?.message ?? error ?? '').toLowerCase();
  const status = Number(candidate?.status);
  if (options.surface === 'telegram' && status === 400) return true;
  return /parse entities|invalid[_ ](?:markdown|mrkdwn|blocks)|malformed.*(?:markdown|mrkdwn)|unsupported.*(?:markdown|mrkdwn)|bad[_ ]format|format.*invalid/u.test(
    message
  );
}

/** Convert rich surface markup to conservative plain text for a retry. */
export function stripSurfaceMarkup(text: string): string {
  return text
    .replace(/```[\w-]*\r?\n?/gu, '')
    .replace(/```/gu, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/[\\*_~`]/gu, '')
    .trim();
}

export async function sendSurfaceTextWithFallback<T>(params: {
  surface: string;
  text: string;
  send: (input: { text: string; format: SurfaceMessageFormat }) => Promise<T> | T;
}): Promise<T> {
  const format = getSurfaceCapability(params.surface).format;
  try {
    return await params.send({ text: params.text, format });
  } catch (error) {
    if (!isSurfaceFormatError(error, { surface: params.surface })) throw error;
    logger.warn(
      `[surface-delivery] ${params.surface} rich-text delivery failed; retrying as plain text`
    );
    return params.send({ text: stripSurfaceMarkup(params.text), format: 'plain' });
  }
}

/**
 * Surface-safe chunking: split at newline boundaries and never split inside a
 * code fence. Every returned chunk remains within maxLen, including balancing
 * fences added at a boundary. JS string length is UTF-16 code units, matching
 * the length unit declared by the surface manifests.
 */
export function chunkBridgeMessage(text: string, maxLen = 1900): string[] {
  if (!Number.isFinite(maxLen) || maxLen < 16) {
    throw new RangeError('maxLen must be a finite number of at least 16');
  }
  maxLen = Math.floor(maxLen);
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf('\n', maxLen);
    if (cut <= 0) cut = maxLen;
    let chunk = remaining.slice(0, cut);
    const fenceCount = (chunk.match(/```/g) || []).length;
    let reopenFence = false;
    if (fenceCount % 2 === 1) {
      const suffix = '\n```';
      if (chunk.length + suffix.length > maxLen) {
        const allowed = maxLen - suffix.length;
        cut = remaining.lastIndexOf('\n', allowed);
        if (cut <= 0) cut = allowed;
        chunk = remaining.slice(0, cut);
      }
      const adjustedFenceCount = (chunk.match(/```/g) || []).length;
      if (adjustedFenceCount % 2 === 1) {
        chunk += suffix;
        reopenFence = true;
      }
    }
    chunks.push(chunk);
    remaining = (reopenFence ? '```\n' : '') + remaining.slice(cut).replace(/^\n/, '');
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
