'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import {
  KB_UI_DEFAULT_LOCALE,
  KB_UI_DEFAULT_MESSAGES,
  KB_UI_MESSAGE_KEYS,
  createTranslator,
  type KbTranslate,
} from '../vanilla/kyberion-ui.js';

/**
 * UI-01d: locale + message bundle for the React renderer. Every
 * renderer-default string is a `ui:*` key of the vocabulary catalog
 * (knowledge/product/orchestration/user-facing-vocabulary.json); the host
 * passes one locale's bundle (`getUiMessageBundle(locale).messages` from
 * `@agent/core`, or `buildUiMessageBundle(catalog, locale)` in a browser
 * build that imports the catalog). The translate function is the vanilla
 * renderer's `createTranslator`, so both renderers resolve identically:
 * caller `t` → `messages` → generated default-locale bundle → key.
 */
export interface KbI18nValue {
  locale: string;
  t: KbTranslate;
}

export interface KbI18nProviderProps {
  /** Locale of `messages` (default: the catalog default locale, `en`). */
  locale?: string;
  /** One locale's `{ 'ui:<key>': text }` bundle. */
  messages?: Readonly<Record<string, string>>;
  /** Custom lookup, tried before `messages`. */
  t?: KbTranslate;
  children?: ReactNode;
}

const KbI18nContext = createContext<KbI18nValue>({
  locale: KB_UI_DEFAULT_LOCALE,
  t: createTranslator(),
});

export function KbI18nProvider({ locale, messages, t, children }: KbI18nProviderProps) {
  const value = useMemo<KbI18nValue>(
    () => ({ locale: locale || KB_UI_DEFAULT_LOCALE, t: createTranslator({ messages, t }) }),
    [locale, messages, t]
  );
  return <KbI18nContext.Provider value={value}>{children}</KbI18nContext.Provider>;
}

/** The active locale and translate function (English defaults outside a provider). */
export function useKbI18n(): KbI18nValue {
  return useContext(KbI18nContext);
}

export {
  KB_UI_DEFAULT_LOCALE,
  KB_UI_DEFAULT_MESSAGES,
  KB_UI_MESSAGE_KEYS,
  createTranslator as createKbTranslator,
};
export type { KbTranslate };
