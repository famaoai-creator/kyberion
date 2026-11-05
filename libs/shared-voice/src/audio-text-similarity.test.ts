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

  it('does not mark empty audio text as a pass', () => {
    const result = compareAudioText('テスト', '');
    expect(result.normalized_exact_match).toBe(false);
    expect(result.similarity).toBe(0);
  });
});
