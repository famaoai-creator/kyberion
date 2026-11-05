/**
 * Semantic reply structure (CE-06): an assistant reply is not one text block
 * but `reaction → claim → explanation → next`. Labeling is lexicon-driven so
 * it works for any language the packs cover — punctuation classes are
 * language-agnostic sentence boundaries, not English conventions.
 *
 * Pure — no timers, no I/O.
 */

import type { LanguagePack } from './language-pack.js';

export type ReplySegmentKind = 'reaction' | 'claim' | 'explanation' | 'next';

export interface ReplySegment {
  kind: ReplySegmentKind;
  text: string;
}

/**
 * Sentence boundaries across CJK and Latin scripts — trailing terminators
 * stay attached to their sentence.
 */
const SENTENCE_TERMINATORS = /[。！？!?.\n…]+[」』”'"'"'）)\]]*/;

/** Normalize for marker comparison — case/half-width-insensitive, punctuation-free. */
function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[。！？!?.,、…\s]+$/u, '')
    .trim();
}

/** Split a reply into sentences, preserving trailing terminators. */
export function splitReplySentences(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const sentences: string[] = [];
  let start = 0;
  for (const match of trimmed.matchAll(new RegExp(SENTENCE_TERMINATORS.source, 'gu'))) {
    const end = (match.index ?? 0) + match[0].length;
    const sentence = trimmed.slice(start, end).trim();
    if (sentence) sentences.push(sentence);
    start = end;
  }
  const tail = trimmed.slice(start).trim();
  if (tail) sentences.push(tail);
  return sentences;
}

/** Whether a sentence is a bare acknowledgement (opening reaction slot). */
export function isReactionLike(sentence: string, pack: LanguagePack | null): boolean {
  if (!pack) return false;
  const norm = normalizeForMatch(sentence);
  if (!norm) return false;
  return [...pack.agentBackchannels, ...pack.userBackchannels, ...pack.eotFillers].some(
    (phrase) => norm === normalizeForMatch(phrase)
  );
}

/** Whether a sentence opens with a next-step/wrap-up marker. */
export function isNextStepLike(sentence: string, pack: LanguagePack | null): boolean {
  if (!pack) return false;
  const norm = sentence.normalize('NFKC').toLowerCase().trimStart();
  return pack.nextStepMarkers.some((marker) =>
    norm.startsWith(marker.normalize('NFKC').toLowerCase())
  );
}

/**
 * Label the sentences of a completed reply. The first sentence is a
 * `reaction` only when it is a bare acknowledgement; the first non-reaction
 * sentence is the `claim`; anything after is `explanation` unless it opens
 * with a next-step marker (`next`).
 */
export function segmentReplyStructure(text: string, pack: LanguagePack | null): ReplySegment[] {
  const sentences = splitReplySentences(text);
  const segments: ReplySegment[] = [];
  let claimSeen = false;
  sentences.forEach((sentence, index) => {
    let kind: ReplySegmentKind;
    if (index === 0 && isReactionLike(sentence, pack)) kind = 'reaction';
    else if (isNextStepLike(sentence, pack)) kind = 'next';
    else if (!claimSeen) {
      kind = 'claim';
      claimSeen = true;
    } else kind = 'explanation';
    segments.push({ kind, text: sentence });
  });
  return segments;
}

/**
 * Streaming counterpart of `segmentReplyStructure`: labels each emitted
 * segment as it arrives so the loop can route the fast `reaction` slot
 * ahead of slower content.
 */
export class ReplySegmentLabeler {
  private emitted = 0;
  private claimSeen = false;

  constructor(private readonly pack: LanguagePack | null) {}

  label(segment: string): ReplySegmentKind {
    const index = this.emitted++;
    if (index === 0 && isReactionLike(segment, this.pack)) return 'reaction';
    if (isNextStepLike(segment, this.pack)) return 'next';
    if (!this.claimSeen) {
      this.claimSeen = true;
      return 'claim';
    }
    return 'explanation';
  }
}
