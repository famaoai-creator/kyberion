/**
 * I18N-01: the locale *vocabulary* — the canonical supported-locale type and
 * the normalization rules — with **zero imports**.
 *
 * This is deliberately split out of `locale.ts`. `locale.ts` resolves a
 * locale from the environment (identity file, env vars, OS locale) and so
 * pulls in `node:path`, secure-io and `profile-root` at module scope. ES
 * module imports execute the whole imported graph regardless of which
 * exports are used, which makes `locale.ts` unsafe to bundle into a browser
 * (`'use client'`) chunk.
 *
 * Browser surfaces — the chronos client library in particular — need the
 * same normalization rules as the Node side. Importing them from here keeps
 * one implementation instead of two that silently drift apart. That drift is
 * not hypothetical: when I18N-02 makes the locale set data-driven, a
 * duplicated browser-side copy would keep accepting only `ja`/`en` and the
 * I18N-07 third-locale proof would fail on chronos alone.
 *
 * Keep this file browser-safe and import-free. Browser surfaces pass their
 * statically imported catalog to the shared resolver below.
 *
 * I18N-02: `SUPPORTED_LOCALES` below is generated from the vocabulary
 * catalog's `required_locales` field by `scripts/generate_vocabulary_types.ts`
 * (`pnpm generate:vocabulary-types`, checked by `pnpm check:vocabulary-types`).
 * Adding a locale is a one-line data edit to the catalog plus a
 * regeneration — never a hand-edit of the array below. Do not add an import
 * to read the catalog at runtime here; that would break the browser-bundle
 * safety this file exists for.
 */

// GENERATED-LOCALES:BEGIN
export const SUPPORTED_LOCALES = ['en', 'ja', 'qps-ploc'] as const;
// GENERATED-LOCALES:END

/**
 * The canonical supported-locale type for the whole codebase, derived from
 * {@link SUPPORTED_LOCALES}.
 */
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** Returns the next catalog locale, wrapping at the end of the list. */
export function nextSupportedLocale(locale: SupportedLocale): SupportedLocale {
  const currentIndex = SUPPORTED_LOCALES.indexOf(locale);
  if (currentIndex < 0) return SUPPORTED_LOCALES[0];
  return SUPPORTED_LOCALES[(currentIndex + 1) % SUPPORTED_LOCALES.length];
}

/**
 * Normalizes a raw locale-ish value (`ja`, `ja-JP`, `ja_JP`, `JA`, `en-US`,
 * browser language tags, …) into a {@link SupportedLocale}.
 *
 * Returns `null` for empty/unknown values and for the POSIX "no locale"
 * sentinels (`C`, `POSIX`) — callers treat `null` as "this precedence step
 * said nothing" and fall through to the next one.
 */
export function normalizeLocale(value: unknown): SupportedLocale | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const normalized = raw.toLowerCase().replace(/_/g, '-');
  if (normalized === 'c' || normalized === 'posix') return null;
  for (const locale of SUPPORTED_LOCALES) {
    if (normalized === locale || normalized.startsWith(`${locale}-`)) return locale;
  }
  // Fall back to a bare prefix match (e.g. `jav` should not match `ja`, but
  // `ja` bare already matched above; this only covers tags without a
  // separator that still start with a supported locale, e.g. legacy `jaJP`).
  for (const locale of SUPPORTED_LOCALES) {
    if (normalized.startsWith(locale)) return locale;
  }
  return null;
}

/**
 * IT-03: BCP-47 speech / `Intl` / OOXML language tag per catalog locale. A
 * locale without an entry (a pseudo-locale, or one added before it has
 * speech support) degrades to the English tag, never to a hard-coded
 * `ja-JP`. Extend this table — never a caller-side ternary — when a locale
 * gains a real regional tag.
 */
const LOCALE_BCP47: Partial<Record<SupportedLocale, string>> = {
  en: 'en-US',
  ja: 'ja-JP',
};

/** Maps a locale-ish value to its BCP-47 tag (`ja` -> `ja-JP`, unknown -> `en-US`). */
export function localeToBcp47(value: unknown): string {
  const locale = normalizeLocale(value) ?? SUPPORTED_LOCALES[0];
  return LOCALE_BCP47[locale] ?? LOCALE_BCP47.en ?? 'en-US';
}

/**
 * Narrows a locale-ish value to the locales one surface actually ships
 * (`allowed`), else `fallback`. Replaces `value === 'en' ? 'en' : 'ja'`
 * ternaries in browser apps whose local locale type is a subset of
 * {@link SupportedLocale}.
 */
export function coerceLocale<L extends SupportedLocale>(
  value: unknown,
  allowed: readonly L[],
  fallback: L
): L {
  const locale = normalizeLocale(value);
  return locale && (allowed as readonly SupportedLocale[]).includes(locale)
    ? (locale as L)
    : fallback;
}

/** Locales whose scripts separate words without spaces (so fragments join with ''). */
const SPACELESS_LOCALES: readonly SupportedLocale[] = ['ja'];

/** True when text in this locale joins words / sentences without a space. */
export function localeUsesWordSpaces(value: unknown): boolean {
  const locale = normalizeLocale(value) ?? 'en';
  return !SPACELESS_LOCALES.includes(locale);
}

/**
 * Picks the entry for a locale from a per-locale table, falling back to the
 * `en` entry. Replaces ad-hoc `locale === 'ja' ? ja : en` ternaries so a
 * third locale is a table row, not another branch.
 */
export function pickByLocale<T>(
  value: unknown,
  table: Partial<Record<SupportedLocale, T>> & { en: T }
): T {
  const locale = normalizeLocale(value) ?? 'en';
  return table[locale] ?? table.en;
}

/**
 * Script-based guess of the language a user wrote in: kana (or kana + kanji)
 * -> `ja`; Latin text with at least one plain word (not an id or acronym) -> `en`; anything else
 * (digits, emoji, one-word acks, other scripts) -> `null` so the caller keeps
 * its own default instead of flipping language on an ambiguous message.
 */
export function detectTextLocale(text: unknown): SupportedLocale | null {
  const value = String(text ?? '');
  if (/[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f]/u.test(value)) return 'ja';
  if (/[\u0400-\u04ff\u0590-\u06ff\u0e00-\u0e7f\u1100-\u11ff\uac00-\ud7af]/u.test(value))
    return null;
  // Prose, not an identifier: at least one plain word of 3+ letters. All-caps
  // tokens (REQ-123, MSN-X, API) and tokens with digits / separators are ids.
  const hasWord = value
    .split(/\s+/u)
    .some((token) => /^[A-Za-z']{3,}[.,!?;:]*$/u.test(token) && token !== token.toUpperCase());
  return hasWord ? 'en' : null;
}

export type BrowserVocabularyEntry = Record<string, string>;

export interface BrowserVocabularyCatalog {
  default_locale: string;
  domains?: Record<string, Record<string, BrowserVocabularyEntry>>;
}

export function createBrowserVocabularyResolver(catalog: BrowserVocabularyCatalog) {
  let index: Map<string, Array<{ namespace: string; entry: BrowserVocabularyEntry }>> | null = null;
  const buildIndex = () => {
    const next = new Map<string, Array<{ namespace: string; entry: BrowserVocabularyEntry }>>();
    for (const [namespace, entries] of Object.entries(catalog.domains || {})) {
      for (const [key, entry] of Object.entries(entries || {})) {
        const matches = next.get(key) || [];
        matches.push({ namespace, entry });
        next.set(key, matches);
      }
    }
    return next;
  };
  const resolveEntry = (
    key: string
  ): { namespace: string; key: string; entry: BrowserVocabularyEntry } | null => {
    const separator = key.indexOf(':');
    const namespace = separator < 0 ? undefined : key.slice(0, separator);
    const bareKey = separator < 0 ? key : key.slice(separator + 1);
    if (namespace) {
      const entry = catalog.domains?.[namespace]?.[bareKey];
      return entry ? { namespace, key: bareKey, entry } : null;
    }
    index ||= buildIndex();
    const matches = index.get(bareKey) || [];
    if (matches.length > 1) {
      throw new Error(
        `[vocabulary] ambiguous bare key "${bareKey}" matches multiple namespaces; qualify the lookup.`
      );
    }
    const match = matches[0];
    return match ? { namespace: match.namespace, key: bareKey, entry: match.entry } : null;
  };
  const defaultLocale = () => catalog.default_locale || 'en';
  const renderText = (key: string, locale = 'en') => {
    const resolved = resolveEntry(key);
    if (!resolved) return key;
    return (
      resolved.entry[locale] ||
      resolved.entry[defaultLocale()] ||
      resolved.entry.en ||
      resolved.entry.ja ||
      key
    );
  };
  return {
    defaultLocale,
    resolveEntry,
    renderText,
    renderMessage: (key: string, params: Record<string, string | number>, locale = 'en') => {
      let value = renderText(key, locale);
      for (const [name, replacement] of Object.entries(params)) {
        value = value.replaceAll(`{${name}}`, String(replacement));
      }
      return value;
    },
  };
}

/** Vocabulary domain holding the shared UI kit's renderer-default strings (`ui:*`). */
export const UI_VOCABULARY_DOMAIN = 'ui';

/**
 * A one-locale message bundle for the shared UI renderers
 * (`@agent/shared-ui` React provider / vanilla `renderA2UI({ messages })`):
 * a plain `{ 'ui:<key>': text }` object with raw, un-substituted templates
 * (the renderers interpolate `{name}` placeholders themselves).
 */
export interface UiMessageBundle {
  locale: SupportedLocale;
  messages: Record<string, string>;
}

/**
 * UI-01d: derives the `ui` domain of the vocabulary catalog into a bundle for
 * one locale. Pure and import-free so browser builds that statically import
 * the catalog (chronos / concierge) can call it; Node callers use
 * `getUiMessageBundle()` in `vocabulary-catalog.ts`. A key the locale lacks
 * falls back to the catalog's `default_locale`, then `en`; a key with no text
 * at all is left out (the renderers then fall back to their generated English
 * defaults, then to the key).
 */
export function buildUiMessageBundle(
  catalog: BrowserVocabularyCatalog,
  locale: SupportedLocale
): UiMessageBundle {
  const entries = catalog.domains?.[UI_VOCABULARY_DOMAIN] || {};
  const fallbackLocale = catalog.default_locale || 'en';
  const messages: Record<string, string> = {};
  for (const [key, entry] of Object.entries(entries)) {
    const text = entry?.[locale] || entry?.[fallbackLocale] || entry?.en;
    if (typeof text === 'string' && text) messages[`${UI_VOCABULARY_DOMAIN}:${key}`] = text;
  }
  return { locale, messages };
}
