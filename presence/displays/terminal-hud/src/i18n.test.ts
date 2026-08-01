import { describe, expect, it } from 'vitest';
import { SUPPORTED_LOCALES } from '@agent/core/locale-normalize';
import { toggleLocale } from './i18n.js';

describe('terminal-hud locale cycling', () => {
  it('cycles through every catalog-supported locale instead of a hardcoded pair', () => {
    expect(toggleLocale('en')).toBe(SUPPORTED_LOCALES[1]);
    expect(toggleLocale(SUPPORTED_LOCALES[SUPPORTED_LOCALES.length - 1])).toBe(
      SUPPORTED_LOCALES[0]
    );
  });
});
