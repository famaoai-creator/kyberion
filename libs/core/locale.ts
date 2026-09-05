import * as path from 'node:path';
import { getRegisteredEnvText } from './foundation/env.js';
import { parseSafeJsonObjectInput } from './foundation/json.js';
import { loadVocabularyCatalog } from './vocabulary-catalog.js';
import { resolveActiveProfileRoot } from './profile-root.js';
import { safeExistsSync, safeLstat, safeReadFile } from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import { logger } from './core.js';
import { normalizeLocale, nextSupportedLocale, type SupportedLocale } from './locale-normalize.js';
import { assertScopeContext, type ScopeContext } from './scope-context.js';
import { loadPersonalIdentityAtPath } from './personal-identity-state.js';

/**
 * I18N-01: single source of truth for locale *resolution*.
 *
 * The supported-locale type and the normalization rules live in the
 * import-free `locale-normalize.ts` so browser surfaces can share them; they
 * are re-exported here so Node callers have a single import site.
 */
export { normalizeLocale, nextSupportedLocale, type SupportedLocale };

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
  /** Tenant/entity scope used to resolve locale overlays. */
  scope?: Pick<ScopeContext, 'tenant_slug' | 'organization_id' | 'project_id'>;
}

let cachedDefaultLocale: SupportedLocale | undefined;

function loadCatalogDefaultLocale(): SupportedLocale {
  if (cachedDefaultLocale !== undefined) return cachedDefaultLocale;
  const parsed = loadVocabularyCatalog();
  cachedDefaultLocale = normalizeLocale(parsed?.default_locale) ?? 'en';
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
    const parsed = loadPersonalIdentityAtPath(
      identityPathOverride ?? path.join(resolveActiveProfileRoot(), 'my-identity.json')
    );
    if (!parsed) return null;
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
  const raw = getRegisteredEnvText('KYBERION_UI_LOCALE');
  if (raw === undefined || raw.trim() === '') return null;
  if (!warnedUiLocaleAliasOnce) {
    warnedUiLocaleAliasOnce = true;
    logger.warn('[locale] KYBERION_UI_LOCALE is deprecated; set KYBERION_LOCALE instead.');
  }
  return normalizeLocale(raw);
}

function resolveScopedLocale(scope?: LocaleContext['scope']): SupportedLocale | null {
  if (!scope?.tenant_slug) return null;
  const normalizedScope = assertScopeContext(
    { ...scope, tier: 'confidential' },
    { requireTenant: true }
  );
  const candidates = [
    normalizedScope.project_id
      ? pathResolver.knowledge(
          `confidential/${normalizedScope.tenant_slug}/organizations/${normalizedScope.organization_id || '_'}/projects/${normalizedScope.project_id}/locale.json`
        )
      : null,
    normalizedScope.organization_id
      ? pathResolver.knowledge(
          `confidential/${normalizedScope.tenant_slug}/organizations/${normalizedScope.organization_id}/locale.json`
        )
      : null,
    pathResolver.knowledge(`confidential/${normalizedScope.tenant_slug}/locale.json`),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    try {
      if (!safeExistsSync(candidate) || !safeLstat(candidate).isFile()) continue;
      const parsed = parseSafeJsonObjectInput(
        String(safeReadFile(candidate, { encoding: 'utf8' }) || ''),
        `locale overlay ${candidate}`
      );
      if (!parsed) continue;
      const locale = normalizeLocale(parsed.locale || parsed.default_locale);
      if (locale) return locale;
    } catch {
      // A malformed overlay must not widen scope or crash locale resolution.
    }
  }
  return null;
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
 * 4. the canonical `KYBERION_LOCALE` setting, then the deprecated
 *    `KYBERION_UI_LOCALE` alias (warns once).
 * 5. OS/browser locale: the registered `LANG` setting, then `ctx.navigatorLanguage`
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

  const scopedLocale = resolveScopedLocale(ctx.scope);
  if (scopedLocale) return scopedLocale;

  const identityLocale = resolveIdentityLocale(ctx.identityPath);
  if (identityLocale) return identityLocale;

  const canonicalEnv = normalizeLocale(getRegisteredEnvText('KYBERION_LOCALE'));
  if (canonicalEnv) return canonicalEnv;

  const aliasEnv = readDeprecatedUiLocaleAlias();
  if (aliasEnv) return aliasEnv;

  const osLocale = normalizeLocale(getRegisteredEnvText('LANG'));
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
