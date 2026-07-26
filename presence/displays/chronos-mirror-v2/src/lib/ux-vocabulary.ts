import vocabularyCatalog from '../../../../../knowledge/product/orchestration/user-facing-vocabulary.json';
import { normalizeLocale, type SupportedLocale } from '@agent/core/locale-normalize';
import { renderMessage } from '@agent/core/message-format';

/**
 * I18N-01: the canonical `SupportedLocale` type and normalization rules come
 * from `@agent/core/locale-normalize`, which is import-free precisely so it
 * is safe to pull into a `'use client'` browser bundle. (`@agent/core/locale`
 * itself is NOT safe here — it reads the identity file via `node:path` +
 * secure-io at module scope, and ESM executes the whole imported graph
 * regardless of which exports are used.)
 */
export type { SupportedLocale };

type VocabularyEntry = Record<string, string>;
type VocabularyCatalog = {
  default_locale: SupportedLocale;
  domains?: Record<string, Record<string, VocabularyEntry>>;
};

const catalog = vocabularyCatalog as VocabularyCatalog;
const speechLocales: Record<SupportedLocale, string> = {
  en: 'en-US',
  ja: 'ja-JP',
};

// I18N-02: the catalog moved from a single flat `domains.ux` to namespaced
// domains (`chronos`, `cli`, `status`, `error`, `question`, `common`, plus
// empty `bridge`/`concierge`/`onboarding` slots for I18N-04). chronos code
// still calls uxLabel/uxText with the bare (unqualified) key names, so this
// module keeps resolving them across every namespace — the same
// backward-compat lookup `@agent/core`'s `t()` implements, minimized here to
// stay import-free of secure-io. An ambiguous bare key (present in more than
// one namespace) throws rather than silently picking one, matching the core
// resolver's contract.
let bareKeyIndex: Map<string, VocabularyEntry[]> | null = null;

function buildBareKeyIndex(): Map<string, VocabularyEntry[]> {
  const index = new Map<string, VocabularyEntry[]>();
  for (const entries of Object.values(catalog.domains || {})) {
    for (const [key, entry] of Object.entries(entries || {})) {
      const list = index.get(key) ?? [];
      list.push(entry);
      index.set(key, list);
    }
  }
  return index;
}

function lookupVocabularyEntry(key: string): VocabularyEntry | null {
  if (!bareKeyIndex) bareKeyIndex = buildBareKeyIndex();
  const matches = bareKeyIndex.get(key) ?? [];
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(
      `[ux-vocabulary] ambiguous bare key "${key}" matches multiple namespaces; qualify the lookup or rename the key.`
    );
  }
  return matches[0];
}

/**
 * Chronos-side entry point for steps 2/5/6 of the master precedence chain in
 * `@agent/core/locale` (surface preference → browser language → catalog
 * default). The identity/env steps are Node-only and do not apply in the
 * browser. The normalization rule itself is the shared one — not a copy.
 */
export function normalizeChronosLocale(value: unknown): SupportedLocale {
  return normalizeLocale(value) ?? normalizeLocale(catalog.default_locale) ?? 'en';
}

// UX-03 Task 5: an explicit operator choice (header toggle) persists in
// localStorage and wins over the browser language.
export const CHRONOS_LOCALE_STORAGE_KEY = 'kyberion.chronos.locale';
export const CHRONOS_LOCALE_EVENT = 'kyberion-chronos-locale';

export function readStoredChronosLocale(): SupportedLocale | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(CHRONOS_LOCALE_STORAGE_KEY);
    return value === 'ja' || value === 'en' ? value : null;
  } catch {
    /* storage unavailable (private mode etc.): fall back to navigator */
    return null;
  }
}

export function setChronosLocalePreference(locale: SupportedLocale): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CHRONOS_LOCALE_STORAGE_KEY, locale);
  } catch {
    /* storage unavailable: the event below still updates this session */
  }
  window.dispatchEvent(new CustomEvent(CHRONOS_LOCALE_EVENT, { detail: locale }));
}

/**
 * I18N-01: the browser-safe subset of `libs/core/locale.ts`'s
 * `resolveLocale` precedence chain — steps 2 (surface preference, here the
 * localStorage-persisted header-toggle choice), 5 (`navigator.language`),
 * and 6 (catalog `default_locale`). Steps 1 (explicit arg), 3 (onboarding
 * identity), and 4 (`KYBERION_LOCALE`/`KYBERION_UI_LOCALE` env) are
 * Node-only and do not apply in the browser.
 */
export function resolveChronosLocale(): SupportedLocale {
  if (typeof window !== 'undefined') {
    const stored = readStoredChronosLocale();
    if (stored) return stored;
    return normalizeChronosLocale(window.navigator.language);
  }
  return catalog.default_locale || 'en';
}

export function chronosSpeechLocale(locale = resolveChronosLocale()): string {
  return speechLocales[locale] || speechLocales.en;
}

export function selectChronosLocaleText(
  locale: SupportedLocale,
  variants: { en: string; ja?: string }
): string {
  return variants[locale] || variants[catalog.default_locale] || variants.en;
}

export function uxLabel(key: string, locale = resolveChronosLocale()): string {
  const entry = lookupVocabularyEntry(key);
  if (!entry) return key;
  return entry[locale] || entry[catalog.default_locale] || key;
}

// UX-03 Task 5.3: no per-call fallback — the catalog is the single source
// of truth. A missing key renders as the key itself (loud, greppable) and
// tests/chronos-ux-vocabulary-contract.test.ts fails CI before that ships.
export function uxText(key: string, locale = resolveChronosLocale()): string {
  const entry = lookupVocabularyEntry(key);
  if (!entry) return key;
  return entry[locale] || entry[catalog.default_locale] || key;
}

/**
 * Fallback-carrying variant for DYNAMIC keys only (computed at runtime, so
 * the contract test cannot verify them). Static keys must use uxText.
 */
export function uxTextOr(key: string, fallback: string, locale = resolveChronosLocale()): string {
  const entry = lookupVocabularyEntry(key);
  if (!entry) return fallback;
  return entry[locale] || entry[catalog.default_locale] || fallback;
}

/**
 * Interpolating variant — for messages that carry runtime values.
 *
 * `uxTextOr` alone is a trap for these: the catalog entry replaces the
 * template, so any `${...}` the caller baked into its fallback silently
 * disappears the moment the key resolves. "Dashboard を更新しました。
 * missions=3、agent runtimes=5" becomes "Dashboard を更新しました。" — the
 * message still reads as a sentence, so nothing looks broken, but every
 * number the operator needed is gone.
 *
 * Catalog entries here use ICU-lite `{name}` placeholders, rendered by the
 * shared `@agent/core/message-format` (import-free, hence browser-bundle
 * safe — the same reason `locale-normalize` is split out).
 */
export function uxMessage(
  key: string,
  params: Record<string, string | number>,
  fallback: string,
  locale = resolveChronosLocale()
): string {
  const entry = lookupVocabularyEntry(key);
  const template = entry ? entry[locale] || entry[catalog.default_locale] : undefined;
  return renderMessage(template ?? fallback, params);
}
