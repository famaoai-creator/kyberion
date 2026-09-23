'use client';

import * as React from 'react';
import {
  conciergeText,
  detectConciergeLocale,
  resolveConciergeLocale,
  type ConciergeLocale,
  type ConciergeMessageKey,
} from './i18n';
import {
  CONCIERGE_DISPLAY_STORAGE_KEYS,
  onDisplayPreferencesChange,
  updateDisplayPreferences,
} from './concierge-theme';

/**
 * UI-06: one locale for the whole surface. `ConciergeI18nProvider` (mounted
 * once by the shell) owns the locale so the header's language selector
 * re-renders every page, the rail and the conversation dock together. The
 * choice is a per-viewer convenience kept in `localStorage` (wrapped in
 * try/catch — private windows and blocked storage fall back to the browser
 * language) under the display-preference key shared with 設定 › 表示, whose
 * change event this provider follows. Components rendered outside a
 * provider keep the previous behaviour: their own state, seeded from the
 * browser language.
 */
export const CONCIERGE_LOCALE_STORAGE_KEY = CONCIERGE_DISPLAY_STORAGE_KEYS.locale;

interface ConciergeLocaleContextValue {
  locale: ConciergeLocale;
  setLocale: (locale: ConciergeLocale) => void;
}

const ConciergeLocaleContext = React.createContext<ConciergeLocaleContextValue | null>(null);

export function readStoredConciergeLocale(): ConciergeLocale | null {
  try {
    const stored = window.localStorage.getItem(CONCIERGE_LOCALE_STORAGE_KEY);
    return stored ? resolveConciergeLocale(stored) : null;
  } catch {
    return null;
  }
}

export function ConciergeI18nProvider({ children }: { children?: React.ReactNode }) {
  const [locale, setLocaleState] = React.useState<ConciergeLocale>('ja');

  React.useEffect(() => {
    setLocaleState(readStoredConciergeLocale() ?? detectConciergeLocale());
    return onDisplayPreferencesChange((prefs) => {
      if (prefs.locale) setLocaleState(prefs.locale);
    });
  }, []);

  React.useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = React.useCallback((next: ConciergeLocale) => {
    setLocaleState(next);
    updateDisplayPreferences({ locale: next });
  }, []);

  const value = React.useMemo(() => ({ locale, setLocale }), [locale, setLocale]);
  return React.createElement(ConciergeLocaleContext.Provider, { value }, children);
}

export function useConciergeI18n() {
  const shared = React.useContext(ConciergeLocaleContext);
  const [ownLocale, setOwnLocale] = React.useState<ConciergeLocale>('ja');

  React.useEffect(() => {
    if (!shared) setOwnLocale(detectConciergeLocale());
  }, [shared]);

  const locale = shared ? shared.locale : ownLocale;
  const setLocale = shared ? shared.setLocale : setOwnLocale;

  const t = React.useCallback(
    (key: ConciergeMessageKey, params?: Record<string, string | number>) =>
      conciergeText(key, locale, params),
    [locale]
  );

  return { locale, setLocale, t };
}
