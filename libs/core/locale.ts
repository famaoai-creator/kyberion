import * as path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getRegisteredEnvText } from './foundation/env.js';
import { parseSafeJsonObjectInput } from './foundation/json.js';
import { readTextFile } from './foundation/text.js';
import { loadVocabularyCatalog } from './knowledge/vocabulary-catalog.js';
import { resolveActiveProfileRoot } from './profile-root.js';
import { safeExistsSync, safeLstat } from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import { logger } from './core.js';
import {
  normalizeLocale,
  nextSupportedLocale,
  detectTextLocale,
  localeToBcp47,
  localeUsesWordSpaces,
  pickByLocale,
  type SupportedLocale,
} from './locale-normalize.js';
import { assertScopeContext, type ScopeContext } from './scope-context.js';
import { loadPersonalIdentityAtPath } from './personal-identity-state.js';
import { withExecutionContext } from './authority.js';
import { resolvePolicyIdentityContext } from './identity-context-bridge.js';

/**
 * I18N-01: single source of truth for locale *resolution*.
 *
 * The supported-locale type and the normalization rules live in the
 * import-free `locale-normalize.ts` so browser surfaces can share them; they
 * are re-exported here so Node callers have a single import site.
 */
export {
  normalizeLocale,
  nextSupportedLocale,
  detectTextLocale,
  localeToBcp47,
  localeUsesWordSpaces,
  pickByLocale,
  type SupportedLocale,
};

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

/**
 * S2: least-privilege role that may read exactly one file per tenant —
 * `knowledge/confidential/<tenant>/locale.json` (security-policy.json). Surface
 * runtimes (slack_bridge, surface_runtime, …) cannot read the confidential tier,
 * so the tenant locale is read under this role, bound to the turn's tenant.
 */
export const SCOPE_LOCALE_READER_ROLE = 'scope_locale_reader';

/** Governance denials (tier / role / tenant / role-assumption), as opposed to a missing or malformed file. */
const ACCESS_DENIAL = /\[(?:SECURITY|POLICY_VIOLATION|ROLE_VIOLATION|ROLE_ASSUMPTION_DENIED)\]/;

const warnedDeniedLocaleOverlays = new Set<string>();

function warnLocaleOverlayDenied(candidate: string, error: unknown): void {
  const relative = path.relative(pathResolver.rootDir(), candidate);
  if (warnedDeniedLocaleOverlays.has(relative)) return;
  warnedDeniedLocaleOverlays.add(relative);
  const reason = (error instanceof Error ? error.message : String(error)).split('\n')[0];
  logger.warn(
    `[locale] scope locale overlay ${relative} is not readable by the current role — the reply falls back to the operator locale | ` +
      `grant the runtime role read access or move the locale to the tenant overlay (knowledge/confidential/<tenant>/locale.json, read via ${SCOPE_LOCALE_READER_ROLE}) | ${reason}`
  );
}

/**
 * Reads one locale overlay. Missing files and malformed JSON yield `null`
 * (an overlay is optional and never widens scope); a governance denial is
 * re-thrown so the caller can surface it instead of dropping it silently.
 */
function readLocaleOverlay(candidate: string): SupportedLocale | null {
  try {
    if (!safeExistsSync(candidate) || !safeLstat(candidate).isFile()) return null;
    const parsed = parseSafeJsonObjectInput(readTextFile(candidate), `locale overlay ${candidate}`);
    if (!parsed) return null;
    return normalizeLocale(parsed.locale || parsed.default_locale);
  } catch (error) {
    if (ACCESS_DENIAL.test(error instanceof Error ? error.message : String(error))) throw error;
    return null;
  }
}

function readLocaleOverlayOrWarn(candidate: string, read: () => SupportedLocale | null) {
  try {
    return read();
  } catch (error) {
    warnLocaleOverlayDenied(candidate, error);
    return null;
  }
}

function resolveScopedLocale(scope?: LocaleContext['scope']): SupportedLocale | null {
  if (!scope?.tenant_slug) return null;
  let normalizedScope: ScopeContext;
  try {
    normalizedScope = assertScopeContext(
      { ...scope, tier: 'confidential' },
      { requireTenant: true }
    );
  } catch {
    // A malformed or unauthorized scope never yields a locale (and must not throw from a reply path).
    return null;
  }
  const tenant = normalizedScope.tenant_slug as string;
  // Organization / project overlays are read with the caller's own role (they
  // sit beside the tenant's confidential knowledge, which no narrow role may
  // read); a denial is warned once instead of dropped silently.
  const callerCandidates = [
    normalizedScope.project_id
      ? pathResolver.knowledge(
          `confidential/${tenant}/organizations/${normalizedScope.organization_id || '_'}/projects/${normalizedScope.project_id}/locale.json`
        )
      : null,
    normalizedScope.organization_id
      ? pathResolver.knowledge(
          `confidential/${tenant}/organizations/${normalizedScope.organization_id}/locale.json`
        )
      : null,
  ].filter((value): value is string => Boolean(value));
  for (const candidate of callerCandidates) {
    const locale = readLocaleOverlayOrWarn(candidate, () => readLocaleOverlay(candidate));
    if (locale) return locale;
  }
  // The tenant overlay is read under the narrow reader role bound to the
  // turn's tenant — never for a different tenant than the caller is bound to.
  const callerTenant = resolvePolicyIdentityContext().tenantSlug;
  if (callerTenant && callerTenant !== tenant) return null;
  const tenantCandidate = pathResolver.knowledge(`confidential/${tenant}/locale.json`);
  return readLocaleOverlayOrWarn(tenantCandidate, () =>
    withExecutionContext(
      SCOPE_LOCALE_READER_ROLE,
      () => readLocaleOverlay(tenantCandidate),
      undefined,
      tenant
    )
  );
}

/**
 * The single locale-resolution entry point for the whole codebase.
 * Fixed precedence (highest to lowest):
 *
 * 1. `ctx.explicit` — CLI `--locale` / an explicit API argument.
 * 2. `ctx.surfacePreference` — a surface's own persisted choice (e.g. the
 *    chronos header-toggle value read from localStorage by its caller).
 *    Then the current conversation turn's reply locale (explicit request /
 *    session / channel locale, else the language of the incoming message —
 *    see {@link enterReplyLocale}).
 * 3. Onboarding identity `language` (`my-identity.json` under
 *    `resolveActiveProfileRoot()`).
 * 4. the canonical `KYBERION_LOCALE` setting, then the deprecated
 *    `KYBERION_UI_LOCALE` alias (warns once).
 * 5. OS/browser locale: the registered `LANG` setting, then `ctx.navigatorLanguage`
 *    when a browser caller supplies it, then the process locale
 *    (`Intl.DateTimeFormat().resolvedOptions().locale`).
 * 6. The vocabulary catalog's `default_locale` (warns once: no locale signal).
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

/**
 * IT-02: the locale of the conversation turn currently being answered.
 *
 * Chat surfaces (slack / telegram / discord / imessage / chronos / voice)
 * usually carry no explicit locale, and the operator's identity / env locale
 * is the wrong language for a user who just wrote in another one. The
 * surface runtime enters the turn's reply locale here (explicit request /
 * session / channel locale, else the language detected from the incoming
 * message) and `resolveLocale()` honors it right after an explicit argument
 * or a surface preference — so every reply builder that calls `t()` follows
 * the user without a locale parameter being threaded through each of them.
 */
const replyLocaleStore = new AsyncLocalStorage<{ locale?: SupportedLocale }>();

/**
 * The locale stored for a tenant / organization / project scope
 * (`knowledge/confidential/<tenant>/[organizations/<org>/[projects/<p>/]]locale.json`),
 * or `undefined` when the scope carries no tenant or no overlay exists.
 */
export function resolveScopeLocale(
  scope: LocaleContext['scope'] | null | undefined
): SupportedLocale | undefined {
  return resolveScopedLocale(scope ?? undefined) ?? undefined;
}

/**
 * Derives a turn's reply locale: explicit locale > language detected from the
 * user text > the locale stored for the turn's scope. A turn with no language
 * signal at all (button / action payload, bare id or digit) yields `undefined`
 * so the rest of the {@link resolveLocale} chain (operator identity,
 * `KYBERION_LOCALE`, catalog default) decides.
 */
export function deriveReplyLocale(input: {
  explicit?: string | null;
  text?: string | null;
  scope?: LocaleContext['scope'] | null;
}): SupportedLocale | undefined {
  return (
    normalizeLocale(input.explicit) ??
    detectTextLocale(input.text) ??
    resolveScopeLocale(input.scope) ??
    undefined
  );
}

/** Sets (or clears, with `undefined`) the reply locale for the current async context. */
export function enterReplyLocale(locale: SupportedLocale | undefined): void {
  replyLocaleStore.enterWith({ locale });
}

/** Runs `fn` with the given reply locale scoped to it (and anything it awaits). */
export function runWithReplyLocale<T>(locale: SupportedLocale | undefined, fn: () => T): T {
  return replyLocaleStore.run({ locale }, fn);
}

/** The reply locale of the current conversation turn, when one was entered. */
export function getReplyLocale(): SupportedLocale | undefined {
  return replyLocaleStore.getStore()?.locale;
}

function resolveWithoutExplicit(ctx: LocaleContext): SupportedLocale {
  const surfacePreference = normalizeLocale(ctx.surfacePreference);
  if (surfacePreference) return surfacePreference;

  const replyLocale = getReplyLocale();
  if (replyLocale) return replyLocale;

  const scopedLocale = resolveScopedLocale(ctx.scope);
  if (scopedLocale) return scopedLocale;

  const identityLocale = resolveIdentityLocale(ctx.identityPath);
  if (identityLocale) return identityLocale;

  const canonicalEnv = normalizeLocale(getRegisteredEnvText('KYBERION_LOCALE'));
  if (canonicalEnv) return canonicalEnv;

  const aliasEnv = readDeprecatedUiLocaleAlias();
  if (aliasEnv) return aliasEnv;

  const lang = getRegisteredEnvText('LANG');
  const osLocale = normalizeLocale(lang);
  if (osLocale) return osLocale;

  const navigatorLocale = normalizeLocale(ctx.navigatorLanguage);
  if (navigatorLocale) return navigatorLocale;

  // S3: a daemon launched without LANG (launchd / systemd units) still has a
  // process locale through ICU (LC_ALL / LC_MESSAGES, or the Windows user
  // locale); honor it before the catalog default. When LANG is set (even to
  // C / POSIX) it already is the OS locale answer, so ICU is not consulted.
  // ICU's own no-environment fallback is en-US, the same as the catalog default.
  if (!lang?.trim()) {
    const intlLocale = normalizeLocale(readIntlLocale());
    if (intlLocale) return intlLocale;
  }

  const fallback = resolveDefaultLocale();
  if (!warnedCatalogDefaultOnce) {
    warnedCatalogDefaultOnce = true;
    logger.warn(
      `[locale] no locale signal found; using the catalog default "${fallback}" — onboarding identity language, KYBERION_LOCALE, LANG and the OS locale are all unset or unsupported | ` +
        `set KYBERION_LOCALE (or re-run onboarding to record the operator language) | catalog default_locale=${fallback}`
    );
  }
  return fallback;
}

let warnedCatalogDefaultOnce = false;

function readIntlLocale(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}

/**
 * Test-only: clear the cached catalog default and the warn-once flag so
 * fixtures written at reused paths / env stubs are re-read on the next
 * resolution (mirrors `_resetKnowledgeSlicesCacheForTests`).
 */
export function _resetLocaleModuleStateForTests(): void {
  cachedDefaultLocale = undefined;
  warnedUiLocaleAliasOnce = false;
  warnedDeniedLocaleOverlays.clear();
  warnedCatalogDefaultOnce = false;
}
