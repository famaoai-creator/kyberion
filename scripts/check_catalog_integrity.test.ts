import { spawnSync } from 'node:child_process';
import {
  pathResolver,
  safeExistsSync,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
  withExecutionContext,
} from '@agent/core';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = pathResolver.rootDir();
const THEMES_PATH = pathResolver.rootResolve(
  'knowledge/public/design-patterns/media-templates/themes.json'
);
const VOCABULARY_PATH = pathResolver.knowledge('product/orchestration/user-facing-vocabulary.json');
const UNDEFINED_KEY_FIXTURE_PATH = pathResolver.rootResolve(
  'tests/fixtures/i18n-undefined-key-reference.fixture.ts'
);

function withSudo(fn: () => void): void {
  withExecutionContext('mission_controller', () => {
    const previousSudo = process.env.KYBERION_SUDO;
    process.env.KYBERION_SUDO = 'true';
    try {
      fn();
    } finally {
      if (previousSudo === undefined) delete process.env.KYBERION_SUDO;
      else process.env.KYBERION_SUDO = previousSudo;
    }
  });
}

function runCheckCatalogIntegrity(): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ['--import', './scripts/ts-loader.mjs', 'scripts/check_catalog_integrity.ts'],
    {
      cwd: ROOT,
      encoding: 'utf8',
    }
  );

  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

describe.sequential('check_catalog_integrity', () => {
  let originalThemesJson = '';
  let originalVocabularyJson = '';

  afterEach(() => {
    withSudo(() => {
      if (originalThemesJson) {
        safeWriteFile(THEMES_PATH, originalThemesJson);
      }
      if (originalVocabularyJson) {
        safeWriteFile(VOCABULARY_PATH, originalVocabularyJson);
      }
      if (safeExistsSync(UNDEFINED_KEY_FIXTURE_PATH)) {
        safeRmSync(UNDEFINED_KEY_FIXTURE_PATH, { force: true });
      }
    });
    originalThemesJson = '';
    originalVocabularyJson = '';
  });

  // Asserts GLOBAL repo state; parallel suites legitimately mutate knowledge/
  // and mission dirs mid-run, so retry to let transient churn settle.
  it('passes on the current repository state', { retry: 2 }, () => {
    const result = runCheckCatalogIntegrity();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[check:catalogs] OK');
  });

  it('flags drift when the kyberion token theme changes', () => {
    withExecutionContext('mission_controller', () => {
      const previousSudo = process.env.KYBERION_SUDO;
      process.env.KYBERION_SUDO = 'true';
      try {
        originalThemesJson = String(safeReadFile(THEMES_PATH, { encoding: 'utf8' }) || '');
        const payload = JSON.parse(originalThemesJson) as {
          themes?: Record<string, { colors?: Record<string, string> }>;
        };
        const kyberionStandard = payload.themes?.['kyberion-standard'];
        if (!kyberionStandard?.colors) {
          throw new Error('kyberion-standard colors missing');
        }
        kyberionStandard.colors.accent = '#ff0000';
        safeWriteFile(THEMES_PATH, `${JSON.stringify(payload, null, 2)}\n`);
      } finally {
        if (previousSudo === undefined) delete process.env.KYBERION_SUDO;
        else process.env.KYBERION_SUDO = previousSudo;
      }
    });

    const result = runCheckCatalogIntegrity();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('design-tokens:');
    expect(result.stderr).toContain('kyberion-standard drift');
  });

  // I18N-02: a key missing a required locale must fail check:catalogs (the
  // pre-I18N-02 check only looked at default_locale, so a ja-less key
  // silently passed).
  it('flags a catalog key missing a required locale', () => {
    withSudo(() => {
      originalVocabularyJson = String(safeReadFile(VOCABULARY_PATH, { encoding: 'utf8' }) || '');
      const payload = JSON.parse(originalVocabularyJson) as {
        domains: Record<string, Record<string, Record<string, string>>>;
      };
      delete payload.domains.cli.cli_readiness.ja;
      safeWriteFile(VOCABULARY_PATH, `${JSON.stringify(payload, null, 2)}\n`);
    });

    const result = runCheckCatalogIntegrity();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'user-facing-vocabulary: cli.cli_readiness must define required locale "ja"'
    );
  });

  // I18N-02: a t()/uxText()/uxLabel()/renderVocabularyText() reference to a
  // key absent from the catalog must fail check:catalogs (the forward half
  // of the bidirectional code<->catalog cross-check).
  //
  // The fixture's function name is built from a variable (not written
  // literally as `renderVocabularyText(` in this file's own source) so that
  // check_catalog_integrity's own scan of scripts/*.ts does not mistake
  // *this test's source code* for a real reference — it should only find
  // the reference in the fixture file this test writes at runtime.
  it('flags a code reference to an undefined vocabulary key', () => {
    const vocabFnName = ['render', 'VocabularyText'].join('');
    withSudo(() => {
      safeWriteFile(
        UNDEFINED_KEY_FIXTURE_PATH,
        `import { ${vocabFnName} } from '@agent/core';\n` +
          `export const label = ${vocabFnName}('this_key_does_not_exist_in_the_catalog');\n`
      );
    });

    const result = runCheckCatalogIntegrity();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'references undefined key "this_key_does_not_exist_in_the_catalog"'
    );
  });
});
