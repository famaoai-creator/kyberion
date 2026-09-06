import { describe, expect, it } from 'vitest';
import { extractPlaceholderNames } from '@agent/core/message-format';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import catalog from '../knowledge/product/orchestration/user-facing-vocabulary.json';
import {
  buildPseudoLocalizedCatalog,
  buildPseudoLocalizedDomains,
  decorateLiteralText,
  findDrift,
  pseudoLocalize,
  splitTemplateSegments,
} from './generate_pseudo_locale.js';

describe('generate_pseudo_locale (I18N-07)', () => {
  it('uses the governed vocabulary catalog loader', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/generate_pseudo_locale.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('loadVocabularyCatalog()');
    expect(source).not.toContain('readJson<');
  });

  describe('decorateLiteralText', () => {
    it('maps ascii letters to accented look-alikes, preserving case', () => {
      expect(decorateLiteralText('Hello World')).toBe('Ħėŀŀő Ẇőřŀḓ');
    });

    it('leaves non-letters (digits, punctuation, braces are handled elsewhere) untouched', () => {
      expect(decorateLiteralText('42! -- ok?')).toBe('42! -- őķ?');
    });
  });

  describe('splitTemplateSegments', () => {
    it('returns a single text segment for a template with no placeholders', () => {
      expect(splitTemplateSegments('plain text')).toEqual([{ type: 'text', value: 'plain text' }]);
    });

    it('splits simple {name} placeholders from surrounding literal text', () => {
      expect(splitTemplateSegments('Hello {name}!')).toEqual([
        { type: 'text', value: 'Hello ' },
        { type: 'placeholder', value: '{name}' },
        { type: 'text', value: '!' },
      ]);
    });

    it('captures a whole plural block (including nested braces) as one opaque placeholder segment', () => {
      const template = '{count, plural, one {1 item} other {# items}} left';
      const segments = splitTemplateSegments(template);
      expect(segments).toEqual([
        { type: 'placeholder', value: '{count, plural, one {1 item} other {# items}}' },
        { type: 'text', value: ' left' },
      ]);
    });

    it('handles two separate placeholders in the same template', () => {
      expect(splitTemplateSegments('{a} and {b}')).toEqual([
        { type: 'placeholder', value: '{a}' },
        { type: 'text', value: ' and ' },
        { type: 'placeholder', value: '{b}' },
      ]);
    });
  });

  describe('pseudoLocalize', () => {
    it('wraps the decorated text in the pseudo-locale bracket markers', () => {
      const result = pseudoLocalize('Hello');
      expect(result.startsWith('⟦')).toBe(true);
      expect(result.endsWith('⟧')).toBe(true);
    });

    it('decorates literal text (the plain-ascii source string never appears verbatim)', () => {
      const result = pseudoLocalize('Hello World');
      expect(result).not.toContain('Hello World');
      expect(result).toContain('Ħėŀŀő Ẇőřŀḓ');
    });

    it('preserves a simple {name} placeholder exactly', () => {
      const result = pseudoLocalize('Please provide {input}.');
      expect(result).toContain('{input}');
    });

    it('preserves a plural placeholder block exactly, including the # shorthand', () => {
      const template = 'There {count, plural, one {is # item} other {are # items}} left.';
      const result = pseudoLocalize(template);
      expect(result).toContain('{count, plural, one {is # item} other {are # items}}');
    });

    it('pads the rendered text so it is somewhat longer than the source', () => {
      const source = 'Readiness';
      const result = pseudoLocalize(source);
      expect(result.length).toBeGreaterThan(source.length);
    });

    it('preserves the exact placeholder-name set the placeholder-consistency check compares (I18N-02)', () => {
      // check_catalog_integrity.ts's placeholder-consistency check compares
      // extractPlaceholderNames(en) against extractPlaceholderNames(other
      // locale) for every key. This asserts generate_pseudo_locale.ts never
      // produces a value that would trip that check.
      const templates = [
        'Please provide {input}.',
        'There are {count} more clarification items.',
        'Unknown command "{command}". Try `pnpm kyberion help`.',
        'Agent catalog refreshed. {manifests} manifests, {runtimes} active runtimes.',
        'no placeholders here at all',
      ];
      for (const template of templates) {
        const expectedNames = extractPlaceholderNames(template);
        const actualNames = extractPlaceholderNames(pseudoLocalize(template));
        expect(actualNames).toEqual(expectedNames);
      }
    });

    it('demonstrates the placeholder-consistency check would catch a corrupted placeholder', () => {
      // Sanity-check the *detector*, not just the generator: if pseudoLocalize
      // (or a future edit to it) ever mangled a placeholder — simulated here
      // by hand-corrupting an otherwise-valid pseudo-localized string — the
      // same extractPlaceholderNames-based comparison check:catalogs uses
      // would see a different placeholder set and flag it.
      const template = 'Please provide {input}.';
      const goodResult = pseudoLocalize(template);
      const corruptedResult = goodResult.replace('{input}', '{inpu}');
      expect(extractPlaceholderNames(corruptedResult)).not.toEqual(
        extractPlaceholderNames(template)
      );
      expect(extractPlaceholderNames(goodResult)).toEqual(extractPlaceholderNames(template));
    });
  });

  describe('buildPseudoLocalizedDomains / buildPseudoLocalizedCatalog', () => {
    const fixture = {
      version: '2.0',
      default_locale: 'en',
      required_locales: ['en', 'ja', 'qps-ploc'],
      domains: {
        ns: {
          plain_key: { en: 'Hello', ja: 'こんにちは' },
          placeholder_key: { en: 'Hi {name}', ja: '{name} さん、こんにちは' },
        },
      },
    };

    it('adds a derived qps-ploc entry to every key without touching en/ja', () => {
      const domains = buildPseudoLocalizedDomains(fixture);
      expect(domains.ns.plain_key.en).toBe('Hello');
      expect(domains.ns.plain_key.ja).toBe('こんにちは');
      expect(domains.ns.plain_key['qps-ploc']).toBe(pseudoLocalize('Hello'));
      expect(domains.ns.placeholder_key['qps-ploc']).toContain('{name}');
    });

    it('is a pure derivation from en — re-deriving from a catalog that already has qps-ploc gives the same result (never mutates the prior generation)', () => {
      const once = buildPseudoLocalizedCatalog(fixture);
      const twice = buildPseudoLocalizedCatalog(once);
      expect(twice.domains.ns.plain_key['qps-ploc']).toBe(once.domains.ns.plain_key['qps-ploc']);
      expect(twice.domains.ns.placeholder_key['qps-ploc']).toBe(
        once.domains.ns.placeholder_key['qps-ploc']
      );
    });

    it('leaves other namespaces/domains structurally untouched', () => {
      const catalogWithTwoNamespaces = {
        ...fixture,
        domains: { ...fixture.domains, other: { another_key: { en: 'X', ja: 'Y' } } },
      };
      const domains = buildPseudoLocalizedDomains(catalogWithTwoNamespaces);
      expect(Object.keys(domains)).toEqual(['ns', 'other']);
      expect(domains.other.another_key['qps-ploc']).toBe(pseudoLocalize('X'));
    });
  });

  describe('findDrift', () => {
    it('reports no drift when qps-ploc already matches the derivation', () => {
      const fixture = {
        version: '2.0',
        default_locale: 'en',
        domains: { ns: { key: { en: 'Hello' } } },
      };
      const derived = buildPseudoLocalizedCatalog(fixture);
      expect(findDrift(derived)).toEqual([]);
    });

    it('reports drift when the stored qps-ploc is stale relative to en', () => {
      const fixture = {
        version: '2.0',
        default_locale: 'en',
        domains: { ns: { key: { en: 'Hello', 'qps-ploc': '⟦stale⟧' } } },
      };
      const drift = findDrift(fixture);
      expect(drift).toEqual([
        { namespace: 'ns', key: 'key', expected: pseudoLocalize('Hello'), actual: '⟦stale⟧' },
      ]);
    });

    it('reports drift when qps-ploc is entirely missing', () => {
      const fixture = {
        version: '2.0',
        default_locale: 'en',
        domains: { ns: { key: { en: 'Hello' } } },
      };
      const drift = findDrift(fixture);
      expect(drift).toEqual([
        { namespace: 'ns', key: 'key', expected: pseudoLocalize('Hello'), actual: undefined },
      ]);
    });
  });

  describe('the live catalog', () => {
    it('has no pseudo-locale drift (pnpm generate:pseudo-locale has been run since the last en/ja edit)', () => {
      expect(findDrift(catalog as any)).toEqual([]);
    });
  });
});
