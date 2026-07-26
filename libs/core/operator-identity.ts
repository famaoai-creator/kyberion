import * as path from 'node:path';
import { resolveActiveProfileRoot } from './profile-root.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { resolveLocale, type SupportedLocale } from './locale.js';

/**
 * UX-04 acceptance 5: approval decisions should carry the onboarding
 * identity's name, not a hardcoded 'sovereign-user'. Falls back to the
 * provided default when onboarding has not run (or the file is unreadable).
 *
 * Lives apart from profile-root so that module keeps its dependency-light
 * mockable shape (its tests stub path-resolver with a minimal surface).
 */
export function resolveOperatorDisplayName(fallback = 'sovereign-user'): string {
  try {
    const identityPath = path.join(resolveActiveProfileRoot(), 'my-identity.json');
    if (!safeExistsSync(identityPath)) return fallback;
    const parsed = JSON.parse(String(safeReadFile(identityPath, { encoding: 'utf8' }) || '{}'));
    const name = String(parsed?.name || '').trim();
    return name || fallback;
  } catch {
    return fallback;
  }
}

/**
 * @deprecated Use `resolveLocale` from `./locale.js` instead. Kept as a
 * thin wrapper for existing callers (bridges, surface-runtime-orchestrator).
 *
 * I18N-01: locale resolution now goes through the single `resolveLocale`
 * precedence chain (onboarding identity → `KYBERION_LOCALE` →
 * `KYBERION_UI_LOCALE` (deprecated) → `LANG` → catalog `default_locale`).
 *
 * Behavior change: the old hardcoded `'ja'` fallback is gone. Because the
 * chain still consults `LANG`, a Japanese operator's machine
 * (`LANG=ja_JP.UTF-8`) still resolves to `ja` with no identity/env set;
 * only a machine with no identity, no env, and a non-Japanese/`C` `LANG`
 * now resolves to `en` instead of the old hardcoded `ja` (pinned by tests
 * in `operator-identity.test.ts`). The `fallback` argument is accepted
 * only for call-site compatibility — `resolveLocale` always resolves to a
 * concrete locale, so it is never reached.
 *
 * I18N-07 finding: the parameter/return type was hardcoded to `'ja' | 'en'`,
 * which broke `tsc` the moment `SupportedLocale` grew a third member
 * (`qps-ploc`) — this function's own return statement was no longer
 * assignable to its declared return type. Widened to `SupportedLocale`
 * (the type this function already delegates to) rather than special-casing
 * the new locale.
 */
export function resolveOperatorLocale(fallback: SupportedLocale = 'ja'): SupportedLocale {
  return resolveLocale() ?? fallback;
}
