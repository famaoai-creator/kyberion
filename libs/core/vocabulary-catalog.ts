import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';

/**
 * I18N-02: shared catalog loader + key resolution for the namespaced
 * `user-facing-vocabulary.json`.
 *
 * Split out of `ux-vocabulary.ts` so both it and the new `t()` (`t.ts`) share
 * exactly one parsing/caching implementation and exactly one definition of
 * "how does a bare (unqualified) key resolve across namespaces" — the
 * backward-compatibility lookup the I18N-02 plan requires for the one-release
 * deprecation window of the pre-namespace flat key space.
 */

export type VocabularyEntry = Record<string, string>;

export interface VocabularyCatalogFile {
  version: string;
  default_locale: string;
  required_locales?: string[];
  domains: Record<string, Record<string, VocabularyEntry>>;
}

export interface ResolvedVocabularyEntry {
  namespace: string;
  key: string;
  entry: VocabularyEntry;
}

const VOCABULARY_PATH = pathResolver.knowledge('product/orchestration/user-facing-vocabulary.json');
const VOCABULARY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/user-facing-vocabulary.schema.json'
);

const catalog = defineCatalog<VocabularyCatalogFile>({
  id: 'user-facing-vocabulary',
  path: VOCABULARY_PATH,
  schema: VOCABULARY_SCHEMA_PATH,
});

let cachedCatalog: VocabularyCatalogFile | null | undefined;
let cachedBareIndex: Map<string, ResolvedVocabularyEntry[]> | undefined;

export function loadVocabularyCatalog(): VocabularyCatalogFile | null {
  try {
    const loaded = catalog.load();
    if (cachedCatalog !== loaded) cachedBareIndex = undefined;
    cachedCatalog = loaded;
  } catch {
    cachedCatalog = null;
    cachedBareIndex = undefined;
  }
  return cachedCatalog;
}

function buildBareIndex(catalog: VocabularyCatalogFile): Map<string, ResolvedVocabularyEntry[]> {
  const index = new Map<string, ResolvedVocabularyEntry[]>();
  for (const [namespace, entries] of Object.entries(catalog.domains || {})) {
    for (const [key, entry] of Object.entries(entries || {})) {
      const list = index.get(key) ?? [];
      list.push({ namespace, key, entry });
      index.set(key, list);
    }
  }
  return index;
}

function bareIndex(): Map<string, ResolvedVocabularyEntry[]> {
  if (cachedBareIndex) return cachedBareIndex;
  const catalog = loadVocabularyCatalog();
  cachedBareIndex = catalog ? buildBareIndex(catalog) : new Map();
  return cachedBareIndex;
}

/**
 * Splits a lookup key into an optional explicit namespace and the bare key,
 * using the `namespace:key` qualification convention. Keys never contain
 * `:` themselves (checked by `check:catalogs`), so the first `:` is always
 * the separator.
 */
function splitQualifiedKey(key: string): { namespace?: string; bareKey: string } {
  const separatorIndex = key.indexOf(':');
  if (separatorIndex === -1) return { bareKey: key };
  return { namespace: key.slice(0, separatorIndex), bareKey: key.slice(separatorIndex + 1) };
}

/**
 * Resolves a lookup key (`namespace:key` or a bare `key`) against the
 * catalog.
 *
 * - A qualified `namespace:key` looks up exactly that namespace.
 * - A bare `key` searches every namespace. Zero matches returns `null`
 *   (caller decides the missing-key fallback). More than one match is a
 *   **hard error** — the I18N-02 plan requires ambiguity to fail loudly
 *   rather than silently pick a namespace.
 */
export function resolveVocabularyEntry(key: string): ResolvedVocabularyEntry | null {
  const catalog = loadVocabularyCatalog();
  if (!catalog) return null;
  const { namespace, bareKey } = splitQualifiedKey(key);
  if (namespace) {
    const entry = catalog.domains?.[namespace]?.[bareKey];
    return entry ? { namespace, key: bareKey, entry } : null;
  }
  const matches = bareIndex().get(bareKey) ?? [];
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(
      `[vocabulary] ambiguous bare key "${bareKey}" matches multiple namespaces (${matches
        .map((m) => m.namespace)
        .join(', ')}); reference it as "namespace:${bareKey}" instead.`
    );
  }
  return matches[0];
}

export function _resetVocabularyCatalogCacheForTests(): void {
  cachedCatalog = undefined;
  cachedBareIndex = undefined;
  catalog.reset();
}
