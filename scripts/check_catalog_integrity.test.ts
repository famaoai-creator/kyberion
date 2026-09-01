import { describe, expect, it } from 'vitest';
import {
  collectThemeCatalogViolations,
  collectUndefinedKeyReferenceViolations,
  collectVocabularyCatalogViolations,
  findUnusedVocabularyKeys,
  findUnreferencedGovernanceCatalogs,
  type ThemeEntryShape,
} from './check_catalog_integrity.js';

/**
 * These suites used to inject drift by editing the repository's real
 * `themes.json` / `user-facing-vocabulary.json`, re-running the checker as a
 * subprocess, then restoring the files. `describe.sequential` ordered the tests
 * inside this file, but vitest runs files in parallel — so the interference went
 * both ways: another suite could read a catalog while it was deliberately
 * broken, and residue another suite left under `knowledge/` could make the
 * checker report a violation this file never injected. The result was three
 * tests that passed alone and failed in a full run.
 *
 * The checker now exposes its validation logic as pure functions over supplied
 * data (the shape `check_mission_gate_docs.ts` already uses), so the drift cases
 * assert on fixtures and touch nothing shared.
 *
 * There is deliberately **no** "the repository is currently clean" test here.
 * That is a global-state assertion, and 36 test files legitimately write under
 * `knowledge/` during a run, so inside a parallel suite it measures transient
 * churn rather than the repository. It was flaky even with `retry: 2`. The claim
 * belongs where it can hold: CI runs `pnpm run check -- --scope full --only catalogs` as its own
 * serial step ("Check knowledge catalogs & index freshness"), and `pnpm validate`
 * includes it. Removing it here moves the assertion to where it is valid instead
 * of dropping it.
 */
const EXPECTED_THEMES: Record<string, ThemeEntryShape> = {
  'kyberion-standard': {
    colors: { accent: '#112233', background: '#000000' },
    fonts: { body: 'Inter' },
  },
  'kyberion-sovereign': {
    colors: { accent: '#445566', background: '#111111' },
    fonts: { body: 'Inter' },
  },
};

function themeCatalog(overrides: Partial<Record<string, ThemeEntryShape>> = {}) {
  return {
    default_theme: 'kyberion-standard',
    themes: {
      'kyberion-standard': structuredClone(EXPECTED_THEMES['kyberion-standard']),
      'kyberion-sovereign': structuredClone(EXPECTED_THEMES['kyberion-sovereign']),
      ...overrides,
    },
  };
}

describe('check_catalog_integrity', () => {
  describe('governance catalog usage', () => {
    it('requires an explicit documentation-only declaration for unreferenced catalogs', () => {
      expect(
        findUnreferencedGovernanceCatalogs({
          catalogs: [
            { fileName: 'used-policy.json', documentationOnly: false },
            { fileName: 'unused-policy.json', documentationOnly: false },
            { fileName: 'documented-policy.json', documentationOnly: true },
          ],
          sourceFiles: {
            'libs/core/policy.ts': "pathResolver.knowledge('product/governance/used-policy.json')",
          },
        })
      ).toEqual(['unused-policy.json']);
    });

    it('recognizes a catalog loaded from a path.join filename literal', () => {
      expect(
        findUnreferencedGovernanceCatalogs({
          catalogs: [{ fileName: 'decision-rights.json', documentationOnly: false }],
          sourceFiles: {
            'libs/core/decision-rights.ts': "path.join(baseDir, 'decision-rights.json')",
          },
        })
      ).toEqual([]);
    });
  });

  describe('theme catalog drift', () => {
    it('accepts a catalog that reproduces the generated tokens', () => {
      expect(
        collectThemeCatalogViolations({
          label: 'themes.json',
          catalog: themeCatalog(),
          expectedThemes: EXPECTED_THEMES,
          isRootThemesCatalog: true,
        })
      ).toEqual([]);
    });

    it('flags drift when the kyberion token theme changes', () => {
      const drifted = themeCatalog({
        'kyberion-standard': {
          colors: { accent: '#ff0000', background: '#000000' },
          fonts: { body: 'Inter' },
        },
      });

      const violations = collectThemeCatalogViolations({
        label: 'themes.json',
        catalog: drifted,
        expectedThemes: EXPECTED_THEMES,
        isRootThemesCatalog: true,
      });

      expect(violations).toContain('design-tokens: themes.json kyberion-standard drift');
    });

    it('flags a missing default_theme only on the flat catalog', () => {
      const catalog = { ...themeCatalog(), default_theme: 'something-else' };

      expect(
        collectThemeCatalogViolations({
          label: 'themes.json',
          catalog,
          expectedThemes: EXPECTED_THEMES,
          isRootThemesCatalog: true,
        })
      ).toContain('design-tokens: themes.json default_theme must be kyberion-standard');

      // The decomposed copy under themes/ inherits default_theme, so the same
      // value must not be reported there.
      expect(
        collectThemeCatalogViolations({
          label: 'themes/themes.json',
          catalog,
          expectedThemes: EXPECTED_THEMES,
          isRootThemesCatalog: false,
        })
      ).toEqual([]);
    });
  });

  describe('vocabulary catalog', () => {
    const catalog = () => ({
      default_locale: 'en',
      required_locales: ['en', 'ja'],
      domains: {
        cli: {
          cli_readiness: { en: 'Ready', ja: '準備完了' },
        },
      },
    });

    it('accepts a catalog with every required locale present', () => {
      expect(collectVocabularyCatalogViolations(catalog())).toEqual([]);
    });

    // I18N-02: a key missing a required locale must fail check:catalogs (the
    // pre-I18N-02 check only looked at default_locale, so a ja-less key
    // silently passed).
    it('flags a catalog key missing a required locale', () => {
      const payload = catalog();
      delete (payload.domains.cli.cli_readiness as Record<string, string>).ja;

      expect(collectVocabularyCatalogViolations(payload)).toContain(
        'user-facing-vocabulary: cli.cli_readiness must define required locale "ja"'
      );
    });

    it('flags placeholders that differ between locales', () => {
      const payload = catalog();
      payload.domains.cli.cli_readiness = { en: 'Ready {name}', ja: '準備完了' };

      expect(collectVocabularyCatalogViolations(payload).join('\n')).toContain(
        'placeholders differ between "en" (name) and "ja" (none)'
      );
    });

    it('flags a default_locale outside required_locales', () => {
      const payload = { ...catalog(), default_locale: 'fr' };

      expect(collectVocabularyCatalogViolations(payload)).toContain(
        'user-facing-vocabulary: default_locale "fr" must be a member of required_locales'
      );
    });
  });

  describe('code → catalog references', () => {
    // The fixture's function name is assembled from parts so that the checker's
    // own scan of scripts/*.ts does not read *this test's source* as a real
    // reference to a nonexistent key.
    const vocabFnName = ['render', 'VocabularyText'].join('');
    const resolveKey = (key: string) => (key === 'known_key' ? { en: 'Known' } : undefined);

    // I18N-02: a t()/uxText()/uxLabel()/renderVocabularyText() reference to a
    // key absent from the catalog must fail check:catalogs (the forward half of
    // the bidirectional code<->catalog cross-check).
    it('flags a code reference to an undefined vocabulary key', () => {
      const violations = collectUndefinedKeyReferenceViolations(
        {
          'tests/fixtures/example.ts': `export const label = ${vocabFnName}('this_key_does_not_exist_in_the_catalog');`,
        },
        resolveKey
      );

      expect(violations).toEqual([
        'user-facing-vocabulary: tests/fixtures/example.ts references undefined key "this_key_does_not_exist_in_the_catalog"',
      ]);
    });

    it('accepts a reference to a key that resolves', () => {
      expect(
        collectUndefinedKeyReferenceViolations(
          { 'tests/fixtures/example.ts': `${vocabFnName}('known_key')` },
          resolveKey
        )
      ).toEqual([]);
    });

    it('reads the bare t() form only in scripts/cli.ts', () => {
      const source = "t('this_key_does_not_exist_in_the_catalog')";

      expect(
        collectUndefinedKeyReferenceViolations({ 'scripts/cli.ts': source }, resolveKey)
      ).toHaveLength(1);
      // Elsewhere `t(` is too common a helper name to treat as a catalog lookup.
      expect(
        collectUndefinedKeyReferenceViolations({ 'libs/core/other.ts': source }, resolveKey)
      ).toEqual([]);
      expect(
        collectUndefinedKeyReferenceViolations({ 'scripts\\cli.ts': source }, resolveKey)
      ).toHaveLength(1);
    });

    it('reports an ambiguous key with the resolver error', () => {
      const violations = collectUndefinedKeyReferenceViolations(
        { 'tests/fixtures/example.ts': `${vocabFnName}('ambiguous_key')` },
        () => {
          throw new Error('matches 2 domains');
        }
      );

      expect(violations.join('\n')).toContain(
        'references ambiguous key "ambiguous_key" (matches 2 domains)'
      );
    });
  });

  describe('unused vocabulary references', () => {
    it('accepts namespaced catalogT references and surface registries', () => {
      const catalog = {
        domains: {
          minutes_record: {
            recording_short: { en: 'short' },
          },
          presence_studio: {
            recording_started: { en: 'started' },
          },
        },
      };

      expect(
        findUnusedVocabularyKeys(
          catalog,
          [
            "catalogT('minutes_record:recording_short')",
            "'presence_studio:recording_started'",
          ].join('\n')
        )
      ).toEqual([]);
    });

    it('reports a key that has no quoted bare or namespaced reference', () => {
      expect(
        findUnusedVocabularyKeys(
          { domains: { cli: { cli_readiness: { en: 'Ready' } } } },
          "catalogT('cli:other')"
        )
      ).toEqual(['user-facing-vocabulary: cli.cli_readiness is not referenced anywhere scanned']);
    });
  });
});
