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
 */

/**
 * The canonical supported-locale type for the whole codebase.
 *
 * I18N-02 will make this data-driven from the vocabulary catalog's
 * `required_locales` field; keeping the definition in exactly one place
 * means that change is a one-line edit here rather than a 22-site sweep.
 */
export type SupportedLocale = 'ja' | 'en';

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
  if (normalized.startsWith('ja')) return 'ja';
  if (normalized.startsWith('en')) return 'en';
  return null;
}
