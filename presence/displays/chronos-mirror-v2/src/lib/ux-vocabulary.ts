import vocabularyCatalog from '../../../../../knowledge/product/orchestration/user-facing-vocabulary.json';

export type SupportedLocale = 'en' | 'ja';

type VocabularyCatalog = {
  default_locale: SupportedLocale;
  domains?: Record<string, Record<string, Record<string, string>>>;
};

const catalog = vocabularyCatalog as VocabularyCatalog;
const speechLocales: Record<SupportedLocale, string> = {
  en: 'en-US',
  ja: 'ja-JP',
};

export function normalizeChronosLocale(value: unknown): SupportedLocale {
  const normalized = String(value || catalog.default_locale || 'en')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
  if (normalized.startsWith('ja')) return 'ja';
  return 'en';
}

// UX-03 Task 5: an explicit operator choice (header toggle) persists in
// localStorage and wins over the browser language.
export const CHRONOS_LOCALE_STORAGE_KEY = 'kyberion.chronos.locale';
export const CHRONOS_LOCALE_EVENT = 'kyberion-chronos-locale';

export function readStoredChronosLocale(): SupportedLocale | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.localStorage.getItem(CHRONOS_LOCALE_STORAGE_KEY);
    return value === 'ja' || value === 'en' ? value : null;
  } catch {
    /* storage unavailable (private mode etc.): fall back to navigator */
    return null;
  }
}

export function setChronosLocalePreference(locale: SupportedLocale): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CHRONOS_LOCALE_STORAGE_KEY, locale);
  } catch {
    /* storage unavailable: the event below still updates this session */
  }
  window.dispatchEvent(new CustomEvent(CHRONOS_LOCALE_EVENT, { detail: locale }));
}

export function resolveChronosLocale(): SupportedLocale {
  if (typeof window !== 'undefined') {
    const stored = readStoredChronosLocale();
    if (stored) return stored;
    return normalizeChronosLocale(window.navigator.language);
  }
  return catalog.default_locale || 'en';
}

export function chronosSpeechLocale(locale = resolveChronosLocale()): string {
  return speechLocales[locale] || speechLocales.en;
}

export function selectChronosLocaleText(
  locale: SupportedLocale,
  variants: { en: string; ja?: string }
): string {
  return variants[locale] || variants[catalog.default_locale] || variants.en;
}

export function uxLabel(key: string, locale = resolveChronosLocale()): string {
  const entry = catalog.domains?.ux?.[key];
  if (!entry) return key;
  return entry[locale] || entry[catalog.default_locale] || key;
}

export function uxText(key: string, fallbackEn: string, locale = resolveChronosLocale()): string {
  const entry = catalog.domains?.ux?.[key];
  if (!entry) return fallbackEn;
  return entry[locale] || entry[catalog.default_locale] || fallbackEn;
}
