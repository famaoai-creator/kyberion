import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import {
  buildLocalesBlock,
  buildVocabularyKeys,
  spliceLocalesBlock,
} from './generate_vocabulary_types.js';

describe('generate_vocabulary_types (I18N-02)', () => {
  it('uses the governed vocabulary catalog loader', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/generate_vocabulary_types.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('loadVocabularyCatalog()');
    expect(source).toContain("readTextFile } from '@agent/core/foundation'");
    expect(source).not.toContain('safeReadFile(');
    expect(source).not.toContain('readJson<');
  });

  describe('buildLocalesBlock / spliceLocalesBlock', () => {
    it('renders a sorted, deduplicated locales array literal between markers', () => {
      const block = buildLocalesBlock(['ja', 'en']);
      expect(block).toBe(
        [
          '// GENERATED-LOCALES:BEGIN',
          "export const SUPPORTED_LOCALES = ['en', 'ja'] as const;",
          '// GENERATED-LOCALES:END',
        ].join('\n')
      );
    });

    it('splices the block between existing markers, preserving surrounding content', () => {
      const source = [
        'before',
        '// GENERATED-LOCALES:BEGIN',
        "export const SUPPORTED_LOCALES = ['en'] as const;",
        '// GENERATED-LOCALES:END',
        'after',
      ].join('\n');
      const spliced = spliceLocalesBlock(source, ['en', 'ja']);
      expect(spliced).toBe(
        [
          'before',
          '// GENERATED-LOCALES:BEGIN',
          "export const SUPPORTED_LOCALES = ['en', 'ja'] as const;",
          '// GENERATED-LOCALES:END',
          'after',
        ].join('\n')
      );
    });

    it('throws when the markers are missing (fails loud rather than silently no-op)', () => {
      expect(() => spliceLocalesBlock('no markers here', ['en'])).toThrow(/markers/);
    });
  });

  describe('buildVocabularyKeys', () => {
    it('emits the qualified namespace:key form for every entry', () => {
      const keys = buildVocabularyKeys({
        version: '2.0',
        default_locale: 'en',
        required_locales: ['en'],
        domains: {
          chronos: { chronos_title: { en: 'Title' } },
          cli: { cli_help: { en: 'Help' } },
        },
      });
      expect(keys).toContain('chronos:chronos_title');
      expect(keys).toContain('cli:cli_help');
    });

    it('emits the bare form only when a key is unambiguous across namespaces', () => {
      const keys = buildVocabularyKeys({
        version: '2.0',
        default_locale: 'en',
        required_locales: ['en'],
        domains: {
          a: { shared_key: { en: 'A' }, only_in_a: { en: 'A2' } },
          b: { shared_key: { en: 'B' } },
        },
      });
      // Ambiguous bare key omitted...
      expect(keys).not.toContain('shared_key');
      // ...but both qualified forms remain, and the unambiguous bare key survives.
      expect(keys).toContain('a:shared_key');
      expect(keys).toContain('b:shared_key');
      expect(keys).toContain('only_in_a');
    });

    it('is sorted and free of duplicates', () => {
      const keys = buildVocabularyKeys({
        version: '2.0',
        default_locale: 'en',
        required_locales: ['en'],
        domains: { ns: { only_key: { en: 'X' } } },
      });
      expect(keys).toEqual([...new Set(keys)].sort());
    });
  });
});
