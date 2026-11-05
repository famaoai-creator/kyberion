import { describe, expect, it } from 'vitest';
import { compareAudioText, normalizeAudioText } from './audio-text-similarity.js';

describe('audio text similarity', () => {
  it('normalizes Japanese punctuation, width, case, and fillers', () => {
    expect(normalizeAudioText('  ＡＢＣ、えーと１２３。 ')).toBe('abc123');
  });

  it('uses character metrics for Japanese instead of whitespace-only WER', () => {
    const result = compareAudioText('音声経路の確認です', '音声経路を確認です');
    expect(result.character_error_rate).toBeGreaterThan(0);
    expect(result.word_error_rate).toBeGreaterThan(0);
    expect(result.similarity).toBeGreaterThan(0);
    expect(result.missing_spans.length + result.unexpected_spans.length).toBeGreaterThan(0);
  });

  it('computes Japanese word error rate over segmented words', () => {
    const result = compareAudioText('音声経路の確認です', '音声経路を確認です');
    // One substituted particle out of five words — not a whole-sentence miss.
    expect(result.word_error_rate).toBeCloseTo(0.2, 5);
    expect(result.missing_spans).toEqual(['の']);
    expect(result.unexpected_spans).toEqual(['を']);
  });

  it('computes English word error rate per word, not over the whitespace-stripped form', () => {
    const result = compareAudioText('Turn on the lights.', 'turn off the lights');
    expect(result.word_error_rate).toBeCloseTo(0.25, 5);
    expect(result.missing_spans).toEqual(['on']);
    expect(result.unexpected_spans).toEqual(['off']);
  });

  it('does not mark empty audio text as a pass', () => {
    const result = compareAudioText('テスト', '');
    expect(result.normalized_exact_match).toBe(false);
    expect(result.similarity).toBe(0);
  });
});
