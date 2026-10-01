import { describe, expect, it } from 'vitest';
import { formatDeprecatedScriptNotice, resolveAliasLocale } from './deprecated_script_alias.mjs';

describe('deprecated_script_alias', () => {
  it('renders English by default and Japanese under a ja locale', async () => {
    expect(await formatDeprecatedScriptNotice('chronos', 'scheduler', { LANG: 'C' })).toBe(
      '[deprecated] `pnpm chronos` is renamed to `pnpm scheduler`; the old name still works for now.'
    );
    expect(
      await formatDeprecatedScriptNotice('chronos', 'scheduler', { KYBERION_LOCALE: 'ja' })
    ).toContain('非推奨');
  });

  it('prefers KYBERION_LOCALE over LANG', () => {
    expect(resolveAliasLocale({ KYBERION_LOCALE: 'en', LANG: 'ja_JP.UTF-8' })).toBe('en');
    expect(resolveAliasLocale({ LANG: 'ja_JP.UTF-8' })).toBe('ja');
    expect(resolveAliasLocale({})).toBe('en');
  });
});
