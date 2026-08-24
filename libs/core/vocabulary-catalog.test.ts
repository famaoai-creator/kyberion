import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetVocabularyCatalogCacheForTests,
  loadVocabularyCatalog,
  resolveVocabularyEntry,
} from './vocabulary-catalog.js';
import { createBrowserVocabularyResolver } from './locale-normalize.js';
import {
  renderBrowserVocabularyMessage,
  renderBrowserVocabularyText,
  resolveBrowserVocabularyEntry,
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
