/**
 * Utterance-intent classification for the Conversation Engine (CE-04).
 *
 * What the speaker is DOING, not just what they said: a lone backchannel
 * (「うん」) is not a turn that needs an answer, 「いや、違う」 is a
 * correction that should interrupt, and 「ちょっと待って」 is a hold request
 * the agent should simply acknowledge instead of generating a full reply.
 *
 * Classification is language-pack driven and deterministic — heavy models
 * can replace this behind the same seam later, but the v1 contract must be
 * reproducible on the voice workbench's fake clock.
 *
 * Pure — no timers, no I/O.
 */

import type { LanguagePack } from './language-pack.js';

export type UtteranceIntent =
  'backchannel' | 'correcting' | 'holding' | 'questioning' | 'thinking_aloud' | 'substantive';

export interface UtteranceIntentResult {
  intent: UtteranceIntent;
  /**
   * True when the ENTIRE utterance is made of markers for that intent
   * (a pure backchannel「うんうん」or a pure hold request「ちょっと待って」).
   * Mixed content ("いや、その件なんだけど") is classified but not pure, so
   * callers can restrict shortcuts to unambiguous cases.
   */
  pure: boolean;
  /** The marker that fired, for telemetry. */
  matched?: string;
}

const STRIP_RE = /[\s、。，,.!?！？・「」『』"'()（）]/gu;

function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(STRIP_RE, '');
}

function words(text: string, usesWordSpaces: boolean): string[] {
  const normalized = text.normalize('NFKC').toLowerCase();
  if (!usesWordSpaces) return [normalized.replace(STRIP_RE, '')];
  return normalized
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** True when the whole normalized text consists only of `markers` (any repeat). */
function pureMarkers(
  text: string,
  markers: readonly string[],
  usesWordSpaces: boolean
): string | null {
  if (markers.length === 0) return null;
  const sorted = [...markers].sort((a, b) => b.length - a.length);
  if (usesWordSpaces) {
    const set = new Set(
      sorted.map((m) => m.normalize('NFKC').toLowerCase().replace(STRIP_RE, ' ').trim())
    );
    const toks = words(text, true);
    if (toks.length === 0) return null;
    // Multi-word markers ("hold on") need phrase matching on the joined text.
    const joined = toks.join(' ');
    for (const marker of sorted) {
      const norm = marker.normalize('NFKC').toLowerCase().replace(STRIP_RE, ' ').trim();
      if (joined === norm) return marker;
    }
    return toks.every((token) => set.has(token)) ? toks[0] : null;
  }
  let rest = normalize(text);
  if (!rest) return null;
  for (;;) {
    const hit = sorted.find((marker) => rest.startsWith(marker.normalize('NFKC').toLowerCase()));
    if (!hit) return null;
    rest = rest.slice(hit.normalize('NFKC').toLowerCase().length);
    if (!rest) return hit;
  }
}

/** True when any marker appears inside the normalized text. */
function containsMarker(text: string, markers: readonly string[]): string | null {
  const haystack = normalize(text);
  if (!haystack) return null;
  const sorted = [...markers].sort((a, b) => b.length - a.length);
  for (const marker of sorted) {
    const needle = marker.normalize('NFKC').toLowerCase().replace(STRIP_RE, '');
    if (needle && haystack.includes(needle)) return marker;
  }
  return null;
}

function endsWithMarker(text: string, markers: readonly string[]): string | null {
  const haystack = normalize(text);
  if (!haystack) return null;
  const sorted = [...markers].sort((a, b) => b.length - a.length);
  for (const marker of sorted) {
    const needle = marker.normalize('NFKC').toLowerCase().replace(STRIP_RE, '');
    if (needle && haystack.endsWith(needle)) return marker;
  }
  return null;
}

const QUESTION_END = /[?？]$/;
const JA_QUESTION_ENDINGS = ['ますか', 'ですか', 'かな', 'かい', 'か'];

/**
 * Classify one utterance. Priority: correction > hold > pure backchannel >
 * question > trailing-filler (thinking aloud) > substantive.
 *
 * `pack` is the caller-selected language pack (see `resolveLanguagePack`).
 */
export function classifyUtteranceIntent(text: string, pack: LanguagePack): UtteranceIntentResult {
  const trimmed = text.trim();
  if (!trimmed) return { intent: 'substantive', pure: false };

  const correction = containsMarker(trimmed, pack.correctionMarkers);
  if (correction) {
    const pure = pureMarkers(trimmed, pack.correctionMarkers, pack.usesWordSpaces) !== null;
    return { intent: 'correcting', pure, matched: correction };
  }

  const holdPure = pureMarkers(trimmed, pack.holdMarkers, pack.usesWordSpaces);
  if (holdPure) return { intent: 'holding', pure: true, matched: holdPure };
  const hold = endsWithMarker(trimmed, pack.holdMarkers);
  if (hold) return { intent: 'holding', pure: false, matched: hold };

  const backchannelPure = pureMarkers(trimmed, pack.userBackchannels, pack.usesWordSpaces);
  if (backchannelPure) return { intent: 'backchannel', pure: true, matched: backchannelPure };
  const fillerPure = pureMarkers(trimmed, pack.respondGateFillers, pack.usesWordSpaces);
  if (fillerPure) return { intent: 'backchannel', pure: true, matched: fillerPure };

  const normalized = trimEndPunctuation(trimmed);
  if (QUESTION_END.test(trimmed) || JA_QUESTION_ENDINGS.some((e) => normalized.endsWith(e))) {
    return { intent: 'questioning', pure: false };
  }

  const trailing =
    endsWithMarker(trimmed, pack.eotFillers) ?? endsWithMarker(trimmed, pack.continuationMarkers);
  if (trailing) return { intent: 'thinking_aloud', pure: false, matched: trailing };

  return { intent: 'substantive', pure: false };
}

function trimEndPunctuation(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[。！？!?,、.?\s]+$/u, '');
}
