/**
 * generate_pseudo_locale.ts — I18N-07: proof-of-locale pseudo-locale generator.
 *
 * Derives the catalog's `qps-ploc` value for every key from its `en` value
 * ("pseudo-localization"). This is deliberately a *generated* locale, not a
 * hand-maintained one: it costs no human translation, and — the real reason
 * it exists — untranslated strings are instantly visible, because anything
 * rendering un-decorated is a hardcoded string that never reached the
 * catalog. See the I18N-07 item in
 * INTERNATIONALIZATION_PLAN_2026-07-26.ja.md §4.
 *
 * Decoration scheme:
 *   1. Every ASCII letter in the *literal* (non-placeholder) text is mapped
 *      to an accented Unicode look-alike, case-preserved (`a` -> `ȧ`,
 *      `A` -> `Ȧ`, ...). This makes pseudo-localized text visually distinct
 *      at a glance without needing a special font.
 *   2. `{name}` and `{count, plural, one {...} other {...}}` placeholders —
 *      the ICU MessageFormat subset `libs/core/message-format.ts` supports —
 *      are preserved byte-for-byte. Mangling a placeholder would corrupt the
 *      rendered message, and `scripts/check_catalog_integrity.ts`'s
 *      placeholder-consistency check (via `extractPlaceholderNames`) exists
 *      precisely to catch that; `generate_pseudo_locale.test.ts` proves both
 *      that this generator never touches a placeholder and that the
 *      consistency check's own comparison would flag it if it did.
 *   3. The whole rendered string is wrapped in `⟦`/`⟧` markers and padded
 *      with additional pseudo-decorated filler text (~35% of the original
 *      length, minimum 4 characters) so that UI relying on
 *      Japanese/English string-width assumptions shows its seams too.
 *
 * Never hand-maintain `qps-ploc` catalog entries — always regenerate.
 *
 * Usage:
 *   pnpm generate:pseudo-locale   — write derived qps-ploc values
 *   pnpm check:pseudo-locale      — fail if the catalog's qps-ploc values
 *                                   have drifted from what `en` would derive
 */

import * as path from 'node:path';
import { pathResolver, safeReadFile, safeWriteFile } from '@agent/core';
import { withExecutionContext } from '@agent/core/governance';

const CATALOG_PATH = pathResolver.knowledge('product/orchestration/user-facing-vocabulary.json');
const PSEUDO_LOCALE = 'qps-ploc';

interface VocabularyCatalogFile {
  version: string;
  default_locale: string;
  required_locales?: string[];
  domains: Record<string, Record<string, Record<string, string>>>;
}

// Lowercase ASCII letter -> accented pseudo-locale look-alike. Uppercase is
// derived via `.toUpperCase()` (verified to round-trip correctly for every
// entry here — e.g. 'ȧ'.toUpperCase() === 'Ȧ') rather than hand-enumerated,
// so this map only needs one case per letter.
const ACCENT_MAP: Readonly<Record<string, string>> = {
  a: 'ȧ',
  b: 'ƀ',
  c: 'ƈ',
  d: 'ḓ',
  e: 'ė',
  f: 'ƒ',
  g: 'ɠ',
  h: 'ħ',
  i: 'ï',
  j: 'ĵ',
  k: 'ķ',
  l: 'ŀ',
  m: 'ɱ',
  n: 'ñ',
  o: 'ő',
  p: 'ṗ',
  q: 'ɋ',
  r: 'ř',
  s: 'ş',
  t: 'ŧ',
  u: 'ů',
  v: 'ṽ',
  w: 'ẇ',
  x: 'ẋ',
  y: 'ẏ',
  z: 'ẑ',
};

const PADDING_MARK_OPEN = '⟦';
const PADDING_MARK_CLOSE = '⟧';
const PADDING_SOURCE = 'lorem ipsum dolor sit amet consectetur adipiscing';

type TemplateSegment = { type: 'text' | 'placeholder'; value: string };

/**
 * Splits a template into literal-text segments and opaque placeholder
 * segments. A placeholder segment is a full balanced-brace run starting at a
 * top-level `{` — this covers both simple `{name}` interpolation and
 * `{count, plural, one {...} other {...}}` blocks (nested braces stay inside
 * the same segment), matching the two constructs
 * `libs/core/message-format.ts` supports. Segmenting this way — rather than
 * only recognizing `{name}` — means a plural block's structure (including
 * its `#` shorthand and any nested `{name}`) is preserved exactly, satisfying
 * the "preserve placeholders exactly" requirement without needing to parse
 * ICU plural syntax here.
 */
export function splitTemplateSegments(template: string): TemplateSegment[] {
  const segments: TemplateSegment[] = [];
  let depth = 0;
  let buffer = '';
  for (const ch of template) {
    if (ch === '{') {
      if (depth === 0 && buffer) {
        segments.push({ type: 'text', value: buffer });
        buffer = '';
      }
      depth += 1;
      buffer += ch;
      continue;
    }
    if (ch === '}') {
      buffer += ch;
      if (depth > 0) depth -= 1;
      if (depth === 0) {
        segments.push({ type: 'placeholder', value: buffer });
        buffer = '';
      }
      continue;
    }
    buffer += ch;
  }
  if (buffer) segments.push({ type: depth > 0 ? 'placeholder' : 'text', value: buffer });
  return segments;
}

/** Applies the accent map to every ASCII letter, preserving case. */
export function decorateLiteralText(text: string): string {
  let out = '';
  for (const ch of text) {
    const lower = ch.toLowerCase();
    const mapped = ACCENT_MAP[lower];
    if (!mapped) {
      out += ch;
      continue;
    }
    out += ch === lower ? mapped : mapped.toUpperCase();
  }
  return out;
}

function buildPadding(targetLength: number): string {
  if (targetLength <= 0) return '';
  const decoratedSource = decorateLiteralText(PADDING_SOURCE);
  let out = '';
  while (out.length < targetLength) out += ` ${decoratedSource}`;
  return out.slice(0, targetLength);
}

/**
 * Derives the `qps-ploc` value for a single catalog entry's `en` template.
 * Placeholder segments (per {@link splitTemplateSegments}) pass through
 * unchanged; literal text is decorated via {@link decorateLiteralText}. The
 * whole result is wrapped in `⟦…⟧` and padded ~35% longer so that
 * un-decorated (= never reached the catalog) strings stand out at a glance.
 */
export function pseudoLocalize(enTemplate: string): string {
  const rendered = splitTemplateSegments(enTemplate)
    .map((segment) =>
      segment.type === 'text' ? decorateLiteralText(segment.value) : segment.value
    )
    .join('');
  const padding = buildPadding(Math.max(4, Math.round(enTemplate.length * 0.35)));
  return `${PADDING_MARK_OPEN}${rendered}${padding}${PADDING_MARK_CLOSE}`;
}

function loadCatalog(): VocabularyCatalogFile {
  return JSON.parse(
    String(safeReadFile(CATALOG_PATH, { encoding: 'utf8' }) || '{}')
  ) as VocabularyCatalogFile;
}

/**
 * Builds the full domains object with a derived `qps-ploc` entry added next
 * to every key's existing locales. Source text is the key's `default_locale`
 * value (falling back to `en`) — never the pseudo-locale's own prior value,
 * so this is always a pure derivation from the human-authored source, never
 * a mutation of previously generated output.
 */
export function buildPseudoLocalizedDomains(
  catalog: VocabularyCatalogFile
): VocabularyCatalogFile['domains'] {
  const sourceLocale = catalog.default_locale || 'en';
  const nextDomains: VocabularyCatalogFile['domains'] = {};
  for (const [namespace, entries] of Object.entries(catalog.domains || {})) {
    const nextEntries: Record<string, Record<string, string>> = {};
    for (const [key, localized] of Object.entries(entries || {})) {
      const source = localized[sourceLocale] ?? localized.en ?? Object.values(localized)[0] ?? '';
      nextEntries[key] = { ...localized, [PSEUDO_LOCALE]: pseudoLocalize(source) };
    }
    nextDomains[namespace] = nextEntries;
  }
  return nextDomains;
}

export function buildPseudoLocalizedCatalog(catalog: VocabularyCatalogFile): VocabularyCatalogFile {
  return { ...catalog, domains: buildPseudoLocalizedDomains(catalog) };
}

function serializeCatalog(catalog: VocabularyCatalogFile): string {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

interface DriftEntry {
  namespace: string;
  key: string;
  expected: string;
  actual: string | undefined;
}

/** Diffs the catalog's current `qps-ploc` values against freshly derived ones. */
export function findDrift(catalog: VocabularyCatalogFile): DriftEntry[] {
  const expectedDomains = buildPseudoLocalizedDomains(catalog);
  const drift: DriftEntry[] = [];
  for (const [namespace, entries] of Object.entries(expectedDomains)) {
    for (const [key, localized] of Object.entries(entries)) {
      const expected = localized[PSEUDO_LOCALE];
      const actual = catalog.domains?.[namespace]?.[key]?.[PSEUDO_LOCALE];
      if (actual !== expected) drift.push({ namespace, key, expected, actual });
    }
  }
  return drift;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const shouldCheck = argv.includes('--check');
  const catalog = loadCatalog();
  const rootDir = pathResolver.rootDir();

  return withExecutionContext('ecosystem_architect', () => {
    if (shouldCheck) {
      const drift = findDrift(catalog);
      if (drift.length === 0) {
        console.log('pseudo-locale (qps-ploc) is up to date');
        return;
      }
      console.error('pseudo-locale drift detected — run pnpm generate:pseudo-locale');
      for (const entry of drift.slice(0, 20)) {
        console.error(`- ${entry.namespace}.${entry.key} differs`);
      }
      if (drift.length > 20) {
        console.error(`  ...and ${drift.length - 20} more`);
      }
      process.exitCode = 1;
      return;
    }

    const nextCatalog = buildPseudoLocalizedCatalog(catalog);
    safeWriteFile(CATALOG_PATH, serializeCatalog(nextCatalog));
    console.log(
      `wrote ${path.relative(rootDir, CATALOG_PATH)} (${PSEUDO_LOCALE} entries derived from ${catalog.default_locale || 'en'})`
    );
  });
}

if (process.argv[1] && /generate_pseudo_locale\.(ts|js)$/.test(process.argv[1])) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
