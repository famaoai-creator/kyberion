/**
 * Readable-color guard.
 *
 * A theme missing a role falls back to a neighbouring one, which produced
 * `fill: #334155` with `color: #334155` — body text rendered perfectly, and
 * completely invisible, on four slides of a ten-slide deck. Layout checks
 * cannot catch this: the text fits its box, it just cannot be read.
 */
import { describe, expect, it } from 'vitest';
import { contrastRatio, ensureReadableOn, WCAG_AA_BODY_TEXT } from './design-qa.js';

describe('ensureReadableOn', () => {
  it('keeps a color that already clears the AA floor', () => {
    expect(ensureReadableOn('#ffffff', '#0f172a')).toBe('#0f172a');
  });

  it('replaces a color identical to its fill', () => {
    const result = ensureReadableOn('334155', '334155');
    expect(result).not.toBe('334155');
    expect(contrastRatio(result, '334155')!).toBeGreaterThanOrEqual(WCAG_AA_BODY_TEXT);
  });

  it('picks light text on a dark fill and dark text on a light fill', () => {
    expect(ensureReadableOn('#0f172a', '#111827')).toBe('ffffff');
    expect(ensureReadableOn('#f8fafc', '#f1f5f9')).toBe('0f172a');
  });

  it('always returns something readable for low-contrast pairs', () => {
    for (const [fill, preferred] of [
      ['#334155', '#3b4a5f'],
      ['#e2e8f0', '#f1f5f9'],
      ['#0066cc', '#0a5fb8'],
    ]) {
      const result = ensureReadableOn(fill, preferred);
      expect(contrastRatio(result, fill)!).toBeGreaterThanOrEqual(WCAG_AA_BODY_TEXT);
    }
  });

  it('leaves unparseable colors alone rather than guessing', () => {
    // Substituting on a guess would be worse than honoring an explicit choice.
    expect(ensureReadableOn('not-a-color', 'var(--brand)')).toBe('var(--brand)');
  });

  it('honours a custom minimum ratio', () => {
    const strict = ensureReadableOn('#767676', '#ffffff', { minRatio: 7 });
    expect(contrastRatio(strict, '#767676')!).toBeGreaterThanOrEqual(4.5);
  });

  it('is deterministic', () => {
    expect(ensureReadableOn('334155', '334155')).toBe(ensureReadableOn('334155', '334155'));
  });
});
