import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetVocabularyCatalogCacheForTests,
  getUiMessageBundle,
  loadVocabularyCatalog,
  resolveVocabularyEntry,
} from './vocabulary-catalog.js';
import {
  SUPPORTED_LOCALES,
  buildUiMessageBundle,
  createBrowserVocabularyResolver,
} from './locale-normalize.js';

afterEach(() => {
  _resetVocabularyCatalogCacheForTests();
});

describe('vocabulary-catalog (I18N-02)', () => {
  it('loads the namespaced catalog', () => {
    const catalog = loadVocabularyCatalog();
    expect(catalog).not.toBeNull();
    expect(catalog?.default_locale).toBe('en');
    // I18N-07: qps-ploc is the proof-of-locale pseudo-locale, data-added
    // alongside en/ja.
    expect(catalog?.required_locales).toEqual(['en', 'ja', 'qps-ploc']);
    expect(Object.keys(catalog?.domains ?? {})).toEqual(
      expect.arrayContaining(['chronos', 'cli', 'status', 'error', 'question', 'common'])
    );
  });

  it('resolves a qualified namespace:key lookup', () => {
    const resolved = resolveVocabularyEntry('chronos:chronos_jump_to_section');
    expect(resolved?.namespace).toBe('chronos');
    expect(resolved?.entry.en).toBe('Jump to section');
  });

  it('resolves an unqualified bare key across namespaces when unambiguous', () => {
    const resolved = resolveVocabularyEntry('chronos_jump_to_section');
    expect(resolved?.namespace).toBe('chronos');
    const cliResolved = resolveVocabularyEntry('cli_readiness');
    expect(cliResolved?.namespace).toBe('cli');
    const statusResolved = resolveVocabularyEntry('mission_planned');
    expect(statusResolved?.namespace).toBe('status');
  });

  it('returns null for a key that does not exist anywhere', () => {
    expect(resolveVocabularyEntry('this_key_does_not_exist')).toBeNull();
  });

  it('returns null for a qualified lookup naming a namespace the key is not in', () => {
    expect(resolveVocabularyEntry('cli:chronos_jump_to_section')).toBeNull();
  });
});

describe('browser vocabulary resolver', () => {
  const resolver = createBrowserVocabularyResolver({
    default_locale: 'en',
    domains: {
      concierge: { 'setup.briefing': { en: 'Prepare {name}.', ja: '{name}を準備します。' } },
    },
  });

  it('resolves qualified shared entries and interpolates values', () => {
    const entry = resolver.resolveEntry('concierge:setup.briefing');
    expect(entry?.namespace).toBe('concierge');
    expect(resolver.renderMessage('concierge:setup.briefing', { name: 'Aki' }, 'ja')).toContain(
      'Aki'
    );
  });

  it('keeps missing keys visible instead of inventing user-facing copy', () => {
    expect(resolver.renderText('missing:surface_key', 'ja')).toBe('missing:surface_key');
  });
});

describe('UI-01d: ui message bundle', () => {
  it('builds one locale of the ui domain with qualified keys and default-locale fallback', () => {
    const bundle = buildUiMessageBundle(
      {
        default_locale: 'en',
        domains: {
          ui: { a: { en: 'A', ja: 'エー' }, b: { en: 'B' }, c: {} },
          other: { a: { en: 'not ui' } },
        },
      },
      'ja'
    );
    expect(bundle).toEqual({ locale: 'ja', messages: { 'ui:a': 'エー', 'ui:b': 'B' } });
  });

  it('covers every ui key in every supported locale from the real catalog', () => {
    const catalog = loadVocabularyCatalog()!;
    const keys = Object.keys(catalog.domains.ui).map((key) => `ui:${key}`);
    expect(keys.length).toBeGreaterThan(40);
    for (const locale of SUPPORTED_LOCALES) {
      const { messages } = getUiMessageBundle(locale);
      expect(Object.keys(messages).sort()).toEqual([...keys].sort());
    }
    expect(getUiMessageBundle('ja').messages['ui:skeleton_loading']).toBe('読み込み中');
    expect(getUiMessageBundle('en').messages['ui:skeleton_loading']).toBe('Loading');
  });
});
