import { describe, expect, it } from 'vitest';
import {
  coerceLocale,
  localeToBcp47,
  localeUsesWordSpaces,
  pickByLocale,
  segmentWords,
} from './locale-normalize.js';

describe('locale helpers (IT-03)', () => {
  it('maps locales to BCP-47 tags and degrades unknown ones to en-US', () => {
    expect(localeToBcp47('ja')).toBe('ja-JP');
    expect(localeToBcp47('ja-JP')).toBe('ja-JP');
    expect(localeToBcp47('en')).toBe('en-US');
    expect(localeToBcp47('qps-ploc')).toBe('en-US');
    expect(localeToBcp47(undefined)).toBe('en-US');
  });

  it('picks a per-locale table entry with an en fallback', () => {
    expect(pickByLocale('ja', { en: 'a', ja: 'b' })).toBe('b');
    expect(pickByLocale('en', { en: 'a', ja: 'b' })).toBe('a');
    expect(pickByLocale('qps-ploc', { en: 'a', ja: 'b' })).toBe('a');
    expect(pickByLocale(null, { en: 'a' })).toBe('a');
  });

  it('knows which locales join text without spaces', () => {
    expect(localeUsesWordSpaces('ja')).toBe(false);
    expect(localeUsesWordSpaces('en')).toBe(true);
  });

  it('narrows to the locales a surface ships', () => {
    expect(coerceLocale('en-US', ['en', 'ja'] as const, 'ja')).toBe('en');
    expect(coerceLocale('qps-ploc', ['en', 'ja'] as const, 'ja')).toBe('ja');
    expect(coerceLocale('fr', ['en', 'ja'] as const, 'en')).toBe('en');
  });

  it('segments spaceless Japanese into word-like tokens', () => {
    const tokens = segmentWords('会議の資料を作成しておいてください');
    expect(tokens.length).toBeGreaterThan(3);
    expect(tokens).toContain('会議');
    expect(tokens).toContain('資料');
    expect(tokens).toContain('作成');
  });

  it('segments English words and drops punctuation', () => {
    expect(segmentWords('ship the report, please')).toEqual(['ship', 'the', 'report', 'please']);
  });

  it('respects an explicit locale and keeps mixed-script words', () => {
    const tokens = segmentWords('Slackに投稿して', 'ja');
    expect(tokens).toContain('Slack');
    expect(tokens).toContain('投稿');
  });

  it('returns an empty list for blank input', () => {
    expect(segmentWords('')).toEqual([]);
    expect(segmentWords('   ')).toEqual([]);
    expect(segmentWords(null)).toEqual([]);
  });

  it('passes well-formed non-catalog locale tags through to the segmenter', () => {
    // 'zh' is not a catalog locale — it must reach Intl.Segmenter untouched
    // rather than silently degrading to en-US (which returns CJK as one run).
    const tokens = segmentWords('これはテストです', 'zh');
    expect(tokens.length).toBeGreaterThan(1);
  });

  it('degrades safely on malformed locale tags', () => {
    expect(() => segmentWords('hello world', 'not a locale!')).not.toThrow();
    expect(segmentWords('hello world', 'not a locale!')).toEqual(['hello', 'world']);
  });
});
