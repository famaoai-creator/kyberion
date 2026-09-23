/**
 * UI-08: per-viewer display preferences (theme + language), shared with the
 * front-desk surfaces: the same `localStorage` keys as concierge
 * (`kyberion.ui.theme` / `kyberion.ui.locale`) and the `kb-ui-locale` cookie
 * (cookies are shared across loopback ports while localStorage is not). The
 * cookie is also what the server pages read to render in the viewer's
 * language. Every storage access is best-effort (try/catch).
 */
import type { OperatorLocale } from './i18n';

export type OperatorThemePreference = 'system' | 'light' | 'dark';

export const DISPLAY_STORAGE_KEYS = Object.freeze({
  theme: 'kyberion.ui.theme',
  locale: 'kyberion.ui.locale',
});

export const UI_LOCALE_COOKIE = 'kb-ui-locale';

export function normalizeThemePreference(value: unknown): OperatorThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
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

export function readThemePreference(): OperatorThemePreference {
  return normalizeThemePreference(readKey(DISPLAY_STORAGE_KEYS.theme));
}

export function readStoredLocale(): OperatorLocale | null {
  const value = readKey(DISPLAY_STORAGE_KEYS.locale);
  return value === 'ja' || value === 'en' ? value : null;
}

export function hasLocaleCookie(): boolean {
  try {
    return new RegExp(`(?:^|;)\\s*${UI_LOCALE_COOKIE}=(?:en|ja)\\s*(?:;|$)`).test(
      document.cookie || ''
    );
  } catch {
    return false;
  }
}

export function applyThemePreference(preference: OperatorThemePreference): void {
  const root = document.documentElement;
  if (preference === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', preference);
}

export function storeThemePreference(preference: OperatorThemePreference): void {
  writeKey(DISPLAY_STORAGE_KEYS.theme, preference === 'system' ? null : preference);
  applyThemePreference(preference);
}

export function storeLocalePreference(locale: OperatorLocale): void {
  writeKey(DISPLAY_STORAGE_KEYS.locale, locale);
  try {
    document.cookie = `${UI_LOCALE_COOKIE}=${locale}; path=/; max-age=31536000; SameSite=Lax`;
  } catch {
    // Cookies blocked: the choice still applies after the refresh via storage.
  }
}

/** Inline `<head>` script: applies a pinned light/dark choice before first paint. */
export const THEME_BOOTSTRAP_SCRIPT = `(function(){try{var t=window.localStorage.getItem(${JSON.stringify(
  DISPLAY_STORAGE_KEYS.theme
)});if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;
