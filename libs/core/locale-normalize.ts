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
 * Keep this file import-free.
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
