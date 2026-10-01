import { describe, expect, it } from 'vitest';
import {
  coerceLocale,
  localeToBcp47,
  localeUsesWordSpaces,
  pickByLocale,
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
});
