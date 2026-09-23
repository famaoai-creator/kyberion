/**
 * Always-on voice respond gate (EV-06): decides whether a transcribed turn
 * warrants a response, filtering out pure disfluency ("えーと" / "um…") and
 * the agent's own TTS echoing back through an open mic. Design reference
 * (read-only, not copied): elizaOS `packages/shared/src/voice/respond-gate.ts`
 * — that implementation is English/word-based; this one uses CHARACTER
 * bigram overlap for the echo check so it also works for Japanese, which has
 * no word-boundary whitespace to split on.
 *
 * Pure apart from reading the governed turn-taking lexicon once.
 */

import { loadVoiceTurnTakingLexicon } from './voice-turn-taking-lexicon.js';

/** Japanese fillers that hold the floor without saying anything substantive. */
function jaPureFillerRe(): RegExp {
  const alternation = [...loadVoiceTurnTakingLexicon().ja.respond_gate_fillers]
    .sort((a, b) => b.length - a.length)
    .map((filler) => filler.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  return new RegExp(`^(?:${alternation})+$`, 'u');
}

/** English disfluencies — never a meaningful turn on their own. */
const EN_DISFLUENCIES = new Set([
  'um',
  'uh',
  'uhh',
  'umm',
  'uhm',
  'erm',
  'er',
  'hmm',
  'hm',
  'mm',
  'mmm',
  'ah',
  'eh',
]);

/** Strip sentence punctuation, collapse whitespace to single spaces. */
function normalizeForDisfluency(text: string): string {
  return text
    .trim()
    .replace(/[、。，,.!?！？]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whether `text` is PURE disfluency/filler — nothing substantive to act on.
 * A mix of disfluency and real content ("um, hello") is NOT pure disfluency
 * and returns false, so it still reaches the agent.
 */
export function isPureDisfluency(text: string): boolean {
  const normalized = normalizeForDisfluency(text);
  if (!normalized) return false;

  const words = normalized.toLowerCase().split(' ').filter(Boolean);
  if (words.length > 0 && words.every((word) => EN_DISFLUENCIES.has(word))) {
    return true;
  }

  const noSpace = normalized.replace(/\s+/gu, '');
  return jaPureFillerRe().test(noSpace);
}

// ---------------------------------------------------------------------------
// Own-TTS echo detection
// ---------------------------------------------------------------------------

export interface OwnTtsEchoContext {
  /** The agent's most recently spoken reply, for the echo guard. */
  recentAssistantText?: string;
  /** Age of that reply in ms. The echo guard only applies within `windowMs`. */
  ageMs?: number;
  /**
   * True while the agent is CURRENTLY speaking — forces the echo guard on
   * regardless of `ageMs`, since long-running TTS keeps bleeding into an
   * open mic well past when the reply was first generated.
   */
  speaking?: boolean;
}

export interface OwnTtsEchoOptions {
  /** How recent `recentAssistantText` must be (ms) for the guard to apply. Default 9000. */
  windowMs?: number;
  /** Character-bigram overlap fraction at/above which a turn counts as echo. Default 0.7. */
  overlap?: number;
}

const DEFAULT_ECHO_WINDOW_MS = 9000;
const DEFAULT_ECHO_OVERLAP = 0.7;

/** Lowercase, strip whitespace/punctuation/quoting — leaves bare content characters. */
function normalizeForBigram(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s、。，,.!?！？·「」『』"'()（）\-_]/gu, '')
    .trim();
}

/** Overlapping 2-character windows. A single-character string falls back to itself. */
function charBigrams(text: string): string[] {
  if (text.length < 2) return text.length === 1 ? [text] : [];
  const grams: string[] = [];
  for (let i = 0; i < text.length - 1; i += 1) {
    grams.push(text.slice(i, i + 2));
  }
  return grams;
}

/** Fraction of `a`'s bigrams that also appear in `b` — direction: how much of `a` is covered by `b`. */
function bigramOverlapRatio(a: string, b: string): number {
  const bigramsA = charBigrams(a);
  if (bigramsA.length === 0) return 0;
  const bigramsB = new Set(charBigrams(b));
  if (bigramsB.size === 0) return 0;
  let matches = 0;
  for (const gram of bigramsA) {
    if (bigramsB.has(gram)) matches += 1;
  }
  return matches / bigramsA.length;
}

/**
 * Whether `text` looks like the agent's own TTS bleeding back through an
 * open mic. Uses character-bigram overlap (not word overlap) so it works
 * for Japanese, which has no inter-word whitespace to split on.
 *
 * Design choice: the guard only applies while the reply is "recent" —
 * `ctx.speaking === true`, or `ctx.ageMs` is provided and within
 * `windowMs`. An `ageMs` of `undefined` (unknown recency) does NOT arm the
 * guard — failing open here is deliberate: silently swallowing a genuine
 * turn is worse than an occasional missed echo.
 */
export function isOwnTtsEcho(
  text: string,
  ctx: OwnTtsEchoContext = {},
  o: OwnTtsEchoOptions = {}
): boolean {
  const reply = ctx.recentAssistantText?.trim();
  if (!reply) return false;

  const windowMs = o.windowMs ?? DEFAULT_ECHO_WINDOW_MS;
  const overlapThreshold = o.overlap ?? DEFAULT_ECHO_OVERLAP;
  const echoActive = ctx.speaking === true || (ctx.ageMs !== undefined && ctx.ageMs <= windowMs);
  if (!echoActive) return false;

  const normalizedText = normalizeForBigram(text);
  if (!normalizedText) return false;
  const normalizedReply = normalizeForBigram(reply);

  return bigramOverlapRatio(normalizedText, normalizedReply) >= overlapThreshold;
}

// ---------------------------------------------------------------------------
// Combined gate
// ---------------------------------------------------------------------------

export type ShouldRespondReason = 'disfluency' | 'echo' | 'empty';

export interface ShouldRespondResult {
  respond: boolean;
  reason?: ShouldRespondReason;
}

/**
 * Whether a transcribed voice turn warrants sending to the agent. Checks,
 * in order: empty transcript, pure disfluency, own-TTS echo.
 */
export function shouldRespondToVoiceTurn(
  text: string,
  ctx: OwnTtsEchoContext = {}
): ShouldRespondResult {
  const trimmed = text.trim();
  if (!trimmed) return { respond: false, reason: 'empty' };
  if (isPureDisfluency(trimmed)) return { respond: false, reason: 'disfluency' };
  if (isOwnTtsEcho(trimmed, ctx)) return { respond: false, reason: 'echo' };
  return { respond: true };
}
