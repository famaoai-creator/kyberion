/**
 * Cuts a streaming text delta feed into speakable phrases (EV-04) so TTS can
 * start on the first phrase before the model finishes the whole reply. The
 * FIRST phrase uses a short break set (including a plain comma-class pause,
 * per `firstBreak`) and a low character cap so time-to-first-audio stays
 * low; every phrase after that only breaks on a sentence end or the full
 * character cap. Pure — no timers, no I/O.
 */

export interface VoicePhraseChunkerOptions {
  /** Character cap for the FIRST phrase only. Default 24. */
  firstMaxChars?: number;
  /** Character cap for every phrase after the first. Default 80. */
  maxChars?: number;
  /** Break characters the FIRST phrase may additionally cut on. Default '、。！？!?,'. */
  firstBreak?: string;
}

const DEFAULT_FIRST_MAX_CHARS = 24;
const DEFAULT_MAX_CHARS = 80;
const DEFAULT_FIRST_BREAK = '、。！？!?,';

/** Sentence-final marks every later phrase may break on. */
const SENTENCE_END_CHARS = new Set(['。', '！', '？', '!', '?']);

export class VoicePhraseChunker {
  private readonly firstMaxChars: number;
  private readonly maxChars: number;
  private readonly firstBreakChars: Set<string>;
  private buffer = '';
  private firstPhraseEmitted = false;

  constructor(options: VoicePhraseChunkerOptions = {}) {
    this.firstMaxChars = options.firstMaxChars ?? DEFAULT_FIRST_MAX_CHARS;
    this.maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
    this.firstBreakChars = new Set((options.firstBreak ?? DEFAULT_FIRST_BREAK).split(''));
  }

  /** Feed the next text delta. Returns zero or more phrases ready to speak. */
  push(delta: string): string[] {
    if (!delta) return [];
    this.buffer += delta;
    return this.drain(false);
  }

  /** Flush whatever remains buffered as a final phrase (or none if empty/whitespace). */
  flush(): string[] {
    const phrases = this.drain(true);
    const remainder = this.buffer.trim();
    this.buffer = '';
    if (remainder) phrases.push(remainder);
    return phrases;
  }

  private drain(final: boolean): string[] {
    const phrases: string[] = [];
    for (;;) {
      const phrase = this.extractPhrase();
      if (phrase === null) break;
      if (phrase.trim().length > 0) phrases.push(phrase.trim());
    }
    void final;
    return phrases;
  }

  /** Extract one ready phrase from the buffer, or null if none is ready yet. */
  private extractPhrase(): string | null {
    if (this.buffer.length === 0) return null;
    const cap = this.firstPhraseEmitted ? this.maxChars : this.firstMaxChars;

    const breakIndex = this.firstPhraseEmitted
      ? this.findSentenceEnd(this.buffer, cap)
      : this.findFirstBreak(this.buffer, cap);

    if (breakIndex !== -1) {
      return this.take(breakIndex + 1);
    }
    if (this.buffer.length >= cap) {
      return this.take(cap);
    }
    return null;
  }

  /** Index of the first sentence-end char within `[0, cap)`, or -1. */
  private findSentenceEnd(text: string, cap: number): number {
    const limit = Math.min(text.length, cap);
    for (let i = 0; i < limit; i += 1) {
      if (SENTENCE_END_CHARS.has(text[i])) return i;
    }
    // '. ' (period followed by a space) also ends an English sentence.
    for (let i = 0; i < limit - 1; i += 1) {
      if (text[i] === '.' && text[i + 1] === ' ') return i;
    }
    return -1;
  }

  /** Index of the first `firstBreak` char within `[0, cap)`, or -1. */
  private findFirstBreak(text: string, cap: number): number {
    const limit = Math.min(text.length, cap);
    for (let i = 0; i < limit; i += 1) {
      if (this.firstBreakChars.has(text[i])) return i;
    }
    return -1;
  }

  private take(count: number): string {
    const phrase = this.buffer.slice(0, count);
    this.buffer = this.buffer.slice(count);
    this.firstPhraseEmitted = true;
    return phrase;
  }
}
