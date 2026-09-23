/**
 * UI-06: per-viewer display preferences for the shell — theme
 * (system / light / dark), density and language. `system` follows
 * `prefers-color-scheme` through the token stylesheet; `light` / `dark` pin
 * the theme with `data-theme` on `<html>` (`:root[data-theme]`,
 * kyberion-ui-tokens.css).
 *
 * Shared contract with the 設定 › 表示 section
 * (settings/display-preferences.ts): the same `localStorage` keys and the
 * same `kyberion:display-preferences` window event, so a change made in
 * either place (header controls or settings) is picked up by the other.
 * Values are per-viewer conveniences only; every storage access is wrapped
 * in try/catch and falls back to the defaults.
 */
export type ConciergeThemePreference = 'system' | 'light' | 'dark';
export type ConciergeDensityPreference = 'comfortable' | 'compact';

export const CONCIERGE_DISPLAY_STORAGE_KEYS = Object.freeze({
  theme: 'kyberion.ui.theme',
  density: 'kyberion.ui.density',
  locale: 'kyberion.ui.locale',
});

export const CONCIERGE_DISPLAY_EVENT = 'kyberion:display-preferences';

/**
 * Cookie the front-desk shells mirror the language choice into
 * (presence-studio `front-desk-pages.ts` FRONT_DESK_LOCALE_COOKIE renders its
 * page chrome from it). Cookies are shared across loopback ports while
 * localStorage is not, so this is what keeps the two surfaces in one
 * language.
 */
export const FRONT_DESK_LOCALE_COOKIE = 'kb-ui-locale';

function writeLocaleCookie(locale: 'ja' | 'en' | null): void {
  try {
    document.cookie = locale
      ? `${FRONT_DESK_LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; SameSite=Lax`
      : `${FRONT_DESK_LOCALE_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
  } catch {
    // Cookies blocked: the choice still applies to this surface.
  }
}

export interface ConciergeDisplayPreferences {
  theme: ConciergeThemePreference;
  density: ConciergeDensityPreference;
  locale: 'ja' | 'en' | null;
}

function readKey(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeKey(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // best-effort only — the choice still applies to this page view.
  }
}

export function normalizeThemePreference(value: unknown): ConciergeThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function readDisplayPreferences(): ConciergeDisplayPreferences {
  const locale = readKey(CONCIERGE_DISPLAY_STORAGE_KEYS.locale);
  return {
    theme: normalizeThemePreference(readKey(CONCIERGE_DISPLAY_STORAGE_KEYS.theme)),
    density:
      readKey(CONCIERGE_DISPLAY_STORAGE_KEYS.density) === 'compact' ? 'compact' : 'comfortable',
    locale: locale === 'ja' || locale === 'en' ? locale : null,
  };
}

export function applyThemePreference(preference: ConciergeThemePreference): void {
  const root = document.documentElement;
  if (preference === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', preference);
}

/** Persist a partial change, apply the theme, and notify the other controls. */
export function updateDisplayPreferences(
  patch: Partial<ConciergeDisplayPreferences>
): ConciergeDisplayPreferences {
  const next = { ...readDisplayPreferences(), ...patch };
  if (patch.theme !== undefined) {
    writeKey(CONCIERGE_DISPLAY_STORAGE_KEYS.theme, next.theme === 'system' ? null : next.theme);
    applyThemePreference(next.theme);
  }
  if (patch.density !== undefined) writeKey(CONCIERGE_DISPLAY_STORAGE_KEYS.density, next.density);
  if (patch.locale !== undefined) {
    writeKey(CONCIERGE_DISPLAY_STORAGE_KEYS.locale, next.locale);
    writeLocaleCookie(next.locale);
  }
  try {
    window.dispatchEvent(new CustomEvent(CONCIERGE_DISPLAY_EVENT, { detail: next }));
  } catch {
    // Non-DOM environment.
  }
  return next;
}

/** Subscribe to preference changes made anywhere on the page. */
export function onDisplayPreferencesChange(
  listener: (prefs: ConciergeDisplayPreferences) => void
): () => void {
  const handler = () => listener(readDisplayPreferences());
  window.addEventListener(CONCIERGE_DISPLAY_EVENT, handler);
  return () => window.removeEventListener(CONCIERGE_DISPLAY_EVENT, handler);
}

/**
 * Inline `<head>` script: applies a stored light/dark choice before first
 * paint so a pinned theme never flashes the system theme. Kept tiny and
 * self-contained (no imports run before hydration).
 */
export const THEME_BOOTSTRAP_SCRIPT = `(function(){try{var t=window.localStorage.getItem(${JSON.stringify(
  CONCIERGE_DISPLAY_STORAGE_KEYS.theme
)});if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;
