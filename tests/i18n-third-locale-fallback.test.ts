import { describe, expect, it, vi } from 'vitest';

/**
 * I18N-07 proof-of-locale, continued: `t()`'s fallback behavior when a key
 * genuinely lacks a third-locale entry.
 *
 * The real catalog never has this gap today — `pnpm run check -- --scope full --only catalogs`
 * requires every `required_locales` member for every key, so a checked-in
 * catalog with a `qps-ploc`-less key would already fail CI before this test
 * ever runs. To exercise the fallback logic itself (not just its absence in
 * the current data), this file mocks `@agent/core/vocabulary-catalog` with a
 * synthetic entry that only has `en`/`ja`. Kept in its own file because
 * `vi.mock` replaces the module for this file's entire module graph — mixing
 * it into `i18n-third-locale-proof.test.ts` (which needs the real catalog)
 * would make those tests see the mock too.
 */
vi.mock('@agent/core/vocabulary-catalog', () => ({
  loadVocabularyCatalog: () => ({
    version: '2.0',
    default_locale: 'en',
    required_locales: ['en', 'ja', 'qps-ploc'],
    domains: {
      test: {
        only_en_ja: { en: 'English fallback text', ja: '日本語のテキスト' },
      },
    },
  }),
  resolveVocabularyEntry: (key: string) => {
    const bareKey = key.includes(':') ? key.split(':')[1] : key;
    if (bareKey !== 'only_en_ja') return null;
    return {
      namespace: 'test',
      key: 'only_en_ja',
      entry: { en: 'English fallback text', ja: '日本語のテキスト' },
    };
  },
}));

import { t } from '@agent/core/t';
import { logger } from '@agent/core/core';

describe('I18N-07 proof-of-locale: fallback when a key lacks the third locale', () => {
  it('falls back to default_locale (en) rather than throwing when qps-ploc is missing for an existing key', () => {
    expect(t('test:only_en_ja' as any, undefined, 'qps-ploc')).toBe('English fallback text');
  });

  it('still resolves normally for a locale the key does have (ja)', () => {
    expect(t('test:only_en_ja' as any, undefined, 'ja')).toBe('日本語のテキスト');
  });

  it('renders the key itself (with a warning) for a key absent from the catalog entirely, in qps-ploc as in any other locale', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    expect(t('test:does_not_exist_at_all' as any, undefined, 'qps-ploc')).toBe(
      'test:does_not_exist_at_all'
    );
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
