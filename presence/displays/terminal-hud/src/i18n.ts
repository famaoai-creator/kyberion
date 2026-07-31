import { createContext, useContext } from 'react';
import { t as coreT, type VocabularyKey } from '@agent/core/t';
import { resolveLocale, type SupportedLocale } from '@agent/core/locale';

export type TranslateParams = Record<string, string | number>;

export interface I18n {
  locale: SupportedLocale;
  tr: (key: VocabularyKey, params?: TranslateParams) => string;
}

export function makeI18n(locale: SupportedLocale): I18n {
  return { locale, tr: (key, params) => coreT(key, params, locale) };
}

export function defaultLocale(): SupportedLocale {
  return resolveLocale();
}

export function toggleLocale(locale: SupportedLocale): SupportedLocale {
  return locale === 'ja' ? 'en' : 'ja';
}

export const I18nContext = createContext<I18n>(makeI18n(defaultLocale()));

export function useI18n(): I18n {
  return useContext(I18nContext);
}
