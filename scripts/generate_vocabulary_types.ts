/**
 * generate_vocabulary_types.ts — I18N-02: catalog-driven type generation.
 *
 * Two generated artifacts, both derived from
 * `knowledge/product/orchestration/user-facing-vocabulary.json`:
 *
 *   1. `libs/core/locale-normalize.ts`'s `SUPPORTED_LOCALES` array (spliced
 *      between `GENERATED-LOCALES:BEGIN`/`END` markers) — from the catalog's
 *      `required_locales` field. `SupportedLocale` is derived from this array
 *      via `(typeof SUPPORTED_LOCALES)[number]`, so adding a locale is a data
 *      edit to the catalog plus a regeneration, never a hand-edit of a type
 *      union. `locale-normalize.ts` stays import-free (this generator writes
 *      a literal array, not a runtime catalog read) so it stays safe to
 *      bundle into the chronos browser build.
 *   2. `libs/core/vocabulary-keys.generated.ts`'s `VocabularyKey` union type
 *      — every `namespace:key` qualified form, plus (for the one-release
 *      backward-compat window) every bare `key` form that is unambiguous
 *      across namespaces. Referencing an unknown key in `t()` is then a
 *      typecheck error.
 *
 * Same shape as `generate_op_registry.ts` / `generate_subagent_definitions.ts`:
 * `--check` regenerates in-memory and diffs against the committed files.
 *
 * Usage:
 *   pnpm generate:vocabulary-types   — write both generated artifacts
 *   pnpm check:vocabulary-types      — fail if either file has drifted
 */

import { format as prettierFormat, resolveConfig as resolvePrettierConfig } from 'prettier';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { loadVocabularyCatalog } from '@agent/core/vocabulary-catalog';
import { defineGenerator, isDirectScript } from './lib/harness.js';

interface VocabularyCatalogFile {
  version: string;
  default_locale: string;
  required_locales?: string[];
  domains: Record<string, Record<string, Record<string, string>>>;
}

const CATALOG_PATH = pathResolver.knowledge('product/orchestration/user-facing-vocabulary.json');
const LOCALE_NORMALIZE_PATH = pathResolver.rootResolve('libs/core/locale-normalize.ts');
const VOCABULARY_KEYS_PATH = pathResolver.rootResolve('libs/core/vocabulary-keys.generated.ts');

const LOCALES_BEGIN_MARKER = '// GENERATED-LOCALES:BEGIN';
const LOCALES_END_MARKER = '// GENERATED-LOCALES:END';

function loadCatalog(): VocabularyCatalogFile {
  const catalog = loadVocabularyCatalog();
  if (!catalog) {
    throw new Error(`Vocabulary catalog is unavailable: ${CATALOG_PATH}`);
  }
  return catalog;
}

/** Builds the replacement block for locale-normalize.ts's generated locales array. */
export function buildLocalesBlock(requiredLocales: string[]): string {
  const sorted = [...requiredLocales].sort();
  const arrayLiteral = sorted.map((locale) => `'${locale}'`).join(', ');
  return [
    LOCALES_BEGIN_MARKER,
    `export const SUPPORTED_LOCALES = [${arrayLiteral}] as const;`,
    LOCALES_END_MARKER,
  ].join('\n');
}

export function spliceLocalesBlock(source: string, requiredLocales: string[]): string {
  const block = buildLocalesBlock(requiredLocales);
  const beginIndex = source.indexOf(LOCALES_BEGIN_MARKER);
  const endIndex = source.indexOf(LOCALES_END_MARKER);
  if (beginIndex === -1 || endIndex === -1) {
    throw new Error(
      `locale-normalize.ts is missing the ${LOCALES_BEGIN_MARKER}/${LOCALES_END_MARKER} markers`
    );
  }
  const before = source.slice(0, beginIndex);
  const after = source.slice(endIndex + LOCALES_END_MARKER.length);
  return `${before}${block}${after}`;
}

/**
 * Every `namespace:key` qualified key, plus every bare key that is
 * unambiguous across namespaces (i.e. appears in exactly one namespace).
 * A bare key that collides across namespaces is intentionally omitted from
 * the union — callers must use the qualified form, and `check:catalogs`
 * separately fails the build if `t()` is ever called with such a key bare.
 */
export function buildVocabularyKeys(catalog: VocabularyCatalogFile): string[] {
  const bareOccurrences = new Map<string, number>();
  const qualified: string[] = [];
  for (const [namespace, entries] of Object.entries(catalog.domains || {})) {
    for (const key of Object.keys(entries || {})) {
      qualified.push(`${namespace}:${key}`);
      bareOccurrences.set(key, (bareOccurrences.get(key) ?? 0) + 1);
    }
  }
  const bare = [...bareOccurrences.entries()]
    .filter(([, count]) => count === 1)
    .map(([key]) => key);
  return [...new Set([...qualified, ...bare])].sort();
}

function renderVocabularyKeysSource(keys: string[]): string {
  const lines = [
    '// GENERATED FILE — DO NOT EDIT BY HAND.',
    '// Regenerate with: pnpm generate:vocabulary-types',
    '// Check drift with: pnpm check:vocabulary-types',
    '// Source (SSoT): knowledge/product/orchestration/user-facing-vocabulary.json',
    '// Generator: scripts/generate_vocabulary_types.ts',
    '',
    '/**',
    ' * I18N-02: the union of every valid `t()` lookup key — the canonical',
    ' * `namespace:key` qualified form for every catalog entry, plus (for the',
    ' * one-release backward-compat window) the bare unqualified form for every',
    ' * key that is unambiguous across namespaces. Referencing an unknown key is',
    ' * a typecheck error.',
    ' */',
    'export type VocabularyKey =',
    ...keys.map((key) => `  | '${key}'`),
    ';',
    '',
  ];
  return lines.join('\n');
}

async function formatTs(content: string, filePath: string): Promise<string> {
  const config = (await resolvePrettierConfig(filePath)) ?? {};
  return prettierFormat(content, { ...config, parser: 'typescript' });
}

interface BuiltArtifacts {
  localeNormalizeSource: string;
  vocabularyKeysSource: string;
}

export async function buildArtifacts(): Promise<BuiltArtifacts> {
  const catalog = loadCatalog();
  const requiredLocales = catalog.required_locales?.length
    ? catalog.required_locales
    : [catalog.default_locale];
  const currentLocaleNormalize = String(
    safeReadFile(LOCALE_NORMALIZE_PATH, { encoding: 'utf8' }) || ''
  );
  const localeNormalizeSource = await formatTs(
    spliceLocalesBlock(currentLocaleNormalize, requiredLocales),
    LOCALE_NORMALIZE_PATH
  );
  const vocabularyKeysSource = await formatTs(
    renderVocabularyKeysSource(buildVocabularyKeys(catalog)),
    VOCABULARY_KEYS_PATH
  );
  return { localeNormalizeSource, vocabularyKeysSource };
}

export const main = defineGenerator({
  id: 'vocabulary-types',
  outputs: [LOCALE_NORMALIZE_PATH, VOCABULARY_KEYS_PATH],
  async render() {
    const built = await buildArtifacts();
    return [
      { path: LOCALE_NORMALIZE_PATH, content: built.localeNormalizeSource },
      { path: VOCABULARY_KEYS_PATH, content: built.vocabularyKeysSource },
    ];
  },
});

if (
  isDirectScript(import.meta.url, 'generate_vocabulary_types.ts') ||
  isDirectScript(import.meta.url, 'generate_vocabulary_types.js')
)
  void main();
