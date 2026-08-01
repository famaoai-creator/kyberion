import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveOperatorLocale } from './operator-identity.js';
import { _resetLocaleModuleStateForTests } from './locale.js';
import { SUPPORTED_LOCALES } from './locale-normalize.js';

// I18N-01: resolveOperatorLocale is now a thin wrapper over the unified
// resolveLocale() precedence chain (identity → KYBERION_LOCALE →
// KYBERION_UI_LOCALE (deprecated) → LANG → catalog default).
describe('resolveOperatorLocale', () => {
  const savedLocale = process.env.KYBERION_LOCALE;
  const savedUiLocale = process.env.KYBERION_UI_LOCALE;
  const savedLang = process.env.LANG;

  beforeEach(() => {
    delete process.env.KYBERION_LOCALE;
    delete process.env.KYBERION_UI_LOCALE;
    _resetLocaleModuleStateForTests();
  });
  afterEach(() => {
    if (savedLocale === undefined) delete process.env.KYBERION_LOCALE;
    else process.env.KYBERION_LOCALE = savedLocale;
    if (savedUiLocale === undefined) delete process.env.KYBERION_UI_LOCALE;
    else process.env.KYBERION_UI_LOCALE = savedUiLocale;
    if (savedLang === undefined) delete process.env.LANG;
    else process.env.LANG = savedLang;
    _resetLocaleModuleStateForTests();
  });

  it('honors the KYBERION_LOCALE env override (this repo checkout has no identity language set)', () => {
    process.env.KYBERION_LOCALE = 'en';
    expect(resolveOperatorLocale()).toBe('en');
    process.env.KYBERION_LOCALE = 'ja';
    expect(resolveOperatorLocale('en')).toBe('ja');
  });

  it('ignores invalid env values and falls through', () => {
    process.env.KYBERION_LOCALE = 'fr';
    expect(SUPPORTED_LOCALES).toContain(resolveOperatorLocale());
  });

  it('returns a supported locale when no identity exists', () => {
    // (identity may exist in a real profile; both outcomes are valid locales)
    expect(SUPPORTED_LOCALES).toContain(resolveOperatorLocale('en'));
  });

  it('does not use the legacy fallback as a second locale authority', () => {
    process.env.LANG = 'C';
    expect(resolveOperatorLocale('ja')).toBe('en');
  });

  // Behavior-change pin (I18N-01): the old hardcoded 'ja' fallback is gone.
  // With no identity language and no KYBERION_LOCALE/KYBERION_UI_LOCALE set,
  // the chain now falls through to LANG, then the catalog default_locale.
  it('resolves to ja when LANG is ja_JP.UTF-8 and no identity/env override is set', () => {
    process.env.LANG = 'ja_JP.UTF-8';
    expect(resolveOperatorLocale()).toBe('ja');
  });

  it('resolves to en (catalog default) when LANG is C and no identity/env override is set', () => {
    process.env.LANG = 'C';
    expect(resolveOperatorLocale()).toBe('en');
  });
});
