import { describe, expect, it } from 'vitest';
import { VoicePhraseChunker } from './voice-phrase-chunker.js';

describe('VoicePhraseChunker', () => {
  it('does not emit a phrase while under the first-phrase cap with no break char', () => {
    const chunker = new VoicePhraseChunker();
    expect(chunker.push('こんにちは')).toEqual([]);
  });

  it('breaks the FIRST phrase on 、 even well under firstMaxChars', () => {
    const chunker = new VoicePhraseChunker();
    expect(chunker.push('こんにちは、')).toEqual(['こんにちは、']);
  });

  it('breaks the FIRST phrase at firstMaxChars when no break char appears', () => {
    const chunker = new VoicePhraseChunker({ firstMaxChars: 24 });
    const phrases = chunker.push('a'.repeat(30));
    expect(phrases).toEqual(['a'.repeat(24)]);
  });

  it('carries the remainder after a first-phrase cap split into later phrases', () => {
    const chunker = new VoicePhraseChunker({ firstMaxChars: 24, maxChars: 80 });
    chunker.push('a'.repeat(30));
    // 6 leftover 'a's are buffered; flush should surface them as one phrase.
    expect(chunker.flush()).toEqual(['a'.repeat(6)]);
  });

  it('later phrases break on sentence-final punctuation, not on 、', () => {
    const chunker = new VoicePhraseChunker();
    chunker.push('はい、');
    // A later '、' inside the buffer must NOT force a break.
    expect(chunker.push('資料を確認しますが、')).toEqual([]);
    expect(chunker.push('問題ありません。')).toEqual(['資料を確認しますが、問題ありません。']);
  });

  it('later phrases break at maxChars when no sentence end appears', () => {
    const chunker = new VoicePhraseChunker({ firstMaxChars: 5, maxChars: 40 });
    chunker.push('start'); // first phrase, hits firstMaxChars=5
    const phrases = chunker.push('b'.repeat(45));
    expect(phrases).toEqual(['b'.repeat(40)]);
  });

  it('English later phrase breaks on ". " (period + space)', () => {
    const chunker = new VoicePhraseChunker({ firstMaxChars: 3 });
    chunker.push('Hi.'); // first phrase via firstMaxChars cap
    expect(chunker.push('This is fine. And this continues.')).toEqual(['This is fine.']);
  });

  it('flush() emits the remaining buffered text', () => {
    const chunker = new VoicePhraseChunker();
    chunker.push('resid');
    expect(chunker.flush()).toEqual(['resid']);
  });

  it('flush() returns an empty array when nothing is buffered', () => {
    const chunker = new VoicePhraseChunker();
    expect(chunker.flush()).toEqual([]);
  });

  it('never emits an empty or whitespace-only phrase from push()', () => {
    const chunker = new VoicePhraseChunker();
    expect(chunker.push('   ')).toEqual([]);
  });

  it('never emits an empty or whitespace-only phrase from flush()', () => {
    const chunker = new VoicePhraseChunker();
    chunker.push('   ');
    expect(chunker.flush()).toEqual([]);
  });

  it('does not get stuck on consecutive punctuation-only breaks', () => {
    const chunker = new VoicePhraseChunker();
    let pushed: string[] = [];
    expect(() => {
      pushed = chunker.push('、、、こんにちは。');
    }).not.toThrow();
    const phrases = [...pushed, ...chunker.flush()];
    expect(phrases.length).toBeGreaterThan(0);
    expect(phrases.every((p) => p.trim().length > 0)).toBe(true);
    expect(phrases.join('')).toBe('、、、こんにちは。');
  });

  it('honours a custom firstBreak set', () => {
    const chunker = new VoicePhraseChunker({ firstBreak: ';' });
    expect(chunker.push('こんにちは、')).toEqual([]);
    expect(chunker.push('world;')).toEqual(['こんにちは、world;']);
  });

  it('extracts multiple phrases from a single push when several boundaries arrive at once', () => {
    const chunker = new VoicePhraseChunker();
    const first = chunker.push('はい、そうですね。続きます。');
    expect(first[0]).toBe('はい、');
    expect(first.length).toBeGreaterThanOrEqual(2);
    expect(first.join('')).toContain('そうですね。');
  });
});
