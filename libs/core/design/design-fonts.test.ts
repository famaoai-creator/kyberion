import { describe, expect, it } from 'vitest';
import { resolveEastAsianFontFamily, resolveLatinFontFamily } from './design-fonts.js';

describe('design-fonts East Asian detection', () => {
  it.each([
    'BIZ UDPゴシック',
    'BIZ UDPGothic',
    'メイリオ',
    '游ゴシック',
    'Yu Mincho',
    'MS PGothic',
    'IPAexGothic',
    'Noto Serif JP',
    'UD Digi Kyokasho N-R',
  ])('keeps %s in the East Asian slot instead of falling back', (family) => {
    expect(resolveEastAsianFontFamily(family)).toBe(family);
  });

  it('uses a lone Japanese family for Latin text too', () => {
    expect(resolveLatinFontFamily('BIZ UDPゴシック')).toBe('BIZ UDPゴシック');
  });

  it('splits a mixed stack into its Latin and East Asian families', () => {
    expect(resolveLatinFontFamily("Arial, 'BIZ UDPゴシック'")).toBe('Arial');
    expect(resolveEastAsianFontFamily("Arial, 'BIZ UDPゴシック'")).toBe('BIZ UDPゴシック');
  });

  it('still falls back to Noto Sans JP for a Latin-only stack', () => {
    expect(resolveEastAsianFontFamily('Arial, sans-serif')).toBe('Noto Sans JP');
  });
});
