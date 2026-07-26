import * as path from 'node:path';
import { resolveActiveProfileRoot } from './profile-root.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import { logger } from './core.js';
import { normalizeLocale, type SupportedLocale } from './locale-normalize.js';

/**
 * I18N-01: single source of truth for locale *resolution*.
 *
 * The supported-locale type and the normalization rules live in the
 * import-free `locale-normalize.ts` so browser surfaces can share them; they
 * are re-exported here so Node callers have a single import site.
 */
export { normalizeLocale, type SupportedLocale };

/**
 * Inputs a caller may supply to short-circuit the precedence chain at a
 * given step. All fields are optional; omitted steps simply fall through
 * to the next one.
 */
export interface LocaleContext {
  /** CLI `--locale` flag or an explicit API argument. Highest precedence. */
  explicit?: string | null;
  /** Surface-local persisted preference (e.g. chronos localStorage value),
   *  passed in by the caller — this module never touches browser storage. */
  surfacePreference?: string | null;
  /** Override for the onboarding identity file path (tests only). Defaults
   *  to `my-identity.json` under `resolveActiveProfileRoot()`. */
  identityPath?: string;
  /** Browser `navigator.language`, supplied by a browser caller. This
   *  module never reads `window` itself — Node callers omit this. */
  navigatorLanguage?: string | null;
}

const VOCABULARY_PATH = pathResolver.knowledge('product/orchestration/user-facing-vocabulary.json');

// Deliberately NOT reusing ux-vocabulary.ts's catalog loader here: this
// module is imported by operator-identity.ts, and ux-vocabulary.ts is
// rewired (I18N-01) to delegate its own locale resolution to this module.
// Importing ux-vocabulary.ts from here would create an import cycle.
// locale.ts stays dependency-light and reads the one field it needs
// (`default_locale`) through its own tiny, independently-cached loader.
let cachedDefaultLocale: SupportedLocale | undefined;

function loadCatalogDefaultLocale(): SupportedLocale {
  if (cachedDefaultLocale !== undefined) return cachedDefaultLocale;
  try {
    const raw = safeReadFile(VOCABULARY_PATH, {
      encoding: 'utf8',
      label: 'user-facing vocabulary (locale default)',
    }) as string;
    const parsed = JSON.parse(String(raw)) as { default_locale?: string };
    cachedDefaultLocale = normalizeLocale(parsed?.default_locale) ?? 'en';
  } catch {
    cachedDefaultLocale = 'en';
  }
  return cachedDefaultLocale;
}

/**
 * Reads the catalog's `default_locale` (cached, falling back to `'en'` if
 * the catalog is unreadable). This is step 6 (last resort) of
 * {@link resolveLocale}'s precedence chain, and is also exported directly
 * for callers that only need the bare catalog default.
 */
export function resolveDefaultLocale(): SupportedLocale {
  return loadCatalogDefaultLocale();
}

function resolveIdentityLocale(identityPathOverride?: string): SupportedLocale | null {
  try {
    const identityPath =
      identityPathOverride ?? path.join(resolveActiveProfileRoot(), 'my-identity.json');
    if (!safeExistsSync(identityPath)) return null;
    const parsed = JSON.parse(String(safeReadFile(identityPath, { encoding: 'utf8' }) || '{}'));
    const language = String(parsed?.language || '')
      .trim()
      .toLowerCase();
    if (!language) return null;
    // The onboarding wizard lets an operator type "日本語" as a free-text
    // answer rather than an ISO tag; keep honoring that alongside `ja*`.
    if (language.startsWith('ja') || language.includes('日本')) return 'ja';
    if (language.startsWith('en')) return 'en';
    return null;
  } catch {
    return null;
  }
}

let warnedUiLocaleAliasOnce = false;

/**
 * `KYBERION_UI_LOCALE` is a deprecated alias for `KYBERION_LOCALE`. It is
 * still read (one precedence step after the canonical var) but emits a
 * one-time warning naming the replacement.
 */
function readDeprecatedUiLocaleAlias(): SupportedLocale | null {
  const raw = process.env.KYBERION_UI_LOCALE;
  if (raw === undefined || raw.trim() === '') return null;
  if (!warnedUiLocaleAliasOnce) {
    warnedUiLocaleAliasOnce = true;
    logger.warn('[locale] KYBERION_UI_LOCALE is deprecated; set KYBERION_LOCALE instead.');
  }
  return normalizeLocale(raw);
}

/**
 * The single locale-resolution entry point for the whole codebase.
 * Fixed precedence (highest to lowest):
 *
 * 1. `ctx.explicit` — CLI `--locale` / an explicit API argument.
 * 2. `ctx.surfacePreference` — a surface's own persisted choice (e.g. the
 *    chronos header-toggle value read from localStorage by its caller).
 * 3. Onboarding identity `language` (`my-identity.json` under
 *    `resolveActiveProfileRoot()`).
 * 4. `process.env.KYBERION_LOCALE` (canonical), then the deprecated
 *    `KYBERION_UI_LOCALE` alias (warns once).
 * 5. OS/browser locale: `process.env.LANG`, then `ctx.navigatorLanguage`
 *    when a browser caller supplies it.
 * 6. The vocabulary catalog's `default_locale`.
 *
 * Always returns a {@link SupportedLocale} — there is no unresolved case,
 * so callers never need a fallback argument of their own.
 */
export function resolveLocale(ctx: LocaleContext = {}): SupportedLocale {
  const explicit = normalizeLocale(ctx.explicit);
  if (explicit) return explicit;

  // An explicit request we cannot honor must never fail silently: the
  // operator asked for a specific locale and is about to get a different
  // one. (The pre-I18N-01 `scripts/cli.ts` wrote this to stderr; keeping the
  // notice — now at the one place that knows the actual outcome — preserves
  // that behavior for every surface, not just the CLI.)
  const explicitWasRequested = String(ctx.explicit ?? '').trim().length > 0;
  if (explicitWasRequested) {
    const resolved = resolveWithoutExplicit(ctx);
    logger.warn(
      `[locale] requested locale "${String(ctx.explicit).trim()}" is not available; using "${resolved}".`
    );
    return resolved;
  }

  return resolveWithoutExplicit(ctx);
}

function resolveWithoutExplicit(ctx: LocaleContext): SupportedLocale {
  const surfacePreference = normalizeLocale(ctx.surfacePreference);
  if (surfacePreference) return surfacePreference;

  const identityLocale = resolveIdentityLocale(ctx.identityPath);
  if (identityLocale) return identityLocale;

  const canonicalEnv = normalizeLocale(process.env.KYBERION_LOCALE);
  if (canonicalEnv) return canonicalEnv;

  const aliasEnv = readDeprecatedUiLocaleAlias();
  if (aliasEnv) return aliasEnv;

  const osLocale = normalizeLocale(process.env.LANG);
  if (osLocale) return osLocale;

  const navigatorLocale = normalizeLocale(ctx.navigatorLanguage);
  if (navigatorLocale) return navigatorLocale;

  return resolveDefaultLocale();
}

/**
 * Test-only: clear the cached catalog default and the warn-once flag so
 * fixtures written at reused paths / env stubs are re-read on the next
 * resolution (mirrors `_resetKnowledgeSlicesCacheForTests`).
 */
export function _resetLocaleModuleStateForTests(): void {
  cachedDefaultLocale = undefined;
  warnedUiLocaleAliasOnce = false;
}
