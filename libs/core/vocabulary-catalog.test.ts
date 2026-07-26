import { afterEach, describe, expect, it } from 'vitest';
import {
  _resetVocabularyCatalogCacheForTests,
  loadVocabularyCatalog,
  resolveVocabularyEntry,
} from './vocabulary-catalog.js';

afterEach(() => {
  _resetVocabularyCatalogCacheForTests();
});

describe('vocabulary-catalog (I18N-02)', () => {
  it('loads the namespaced catalog', () => {
    const catalog = loadVocabularyCatalog();
    expect(catalog).not.toBeNull();
    expect(catalog?.default_locale).toBe('en');
    expect(catalog?.required_locales).toEqual(['en', 'ja']);
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
