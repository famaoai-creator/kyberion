import type vocabulary from '../../../../../knowledge/product/orchestration/user-facing-vocabulary.json';
import vocabularyCatalog from '../../../../../knowledge/product/orchestration/user-facing-vocabulary.json';
import {
  buildUiMessageBundle,
  createBrowserVocabularyResolver,
} from '@agent/core/locale-normalize';

/**
 * UI-08: 監査モニタ strings live in the shared user-facing vocabulary catalog
 * under the `operator` domain (en + ja; qps-ploc generated). The resolver is
 * pure, so the same helper renders on the server (pages) and in the client
 * shell. Record values (mission ids, reasons, commands) are data and are not
 * translated.
 */
export type OperatorLocale = 'en' | 'ja';
export type OperatorMessageKey = keyof (typeof vocabulary)['domains']['operator'];
type MessageParams = Record<string, string | number>;

export const OPERATOR_DEFAULT_LOCALE: OperatorLocale = 'ja';

const resolver = createBrowserVocabularyResolver(vocabularyCatalog);

export function normalizeOperatorLocale(value: unknown): OperatorLocale | null {
  if (typeof value !== 'string') return null;
  const lower = value.trim().toLowerCase();
  if (lower.startsWith('ja')) return 'ja';
  if (lower.startsWith('en')) return 'en';
  return null;
}

export function operatorText(
  key: OperatorMessageKey,
  locale: OperatorLocale,
  params: MessageParams = {}
): string {
  return resolver.renderMessage(`operator:${String(key)}`, params, locale);
}

/** Bound translator for one locale (pages call `const t = operatorTranslator(locale)`). */
export function operatorTranslator(locale: OperatorLocale) {
  return (key: OperatorMessageKey, params?: MessageParams) => operatorText(key, locale, params);
}

export type OperatorTranslate = ReturnType<typeof operatorTranslator>;

/** `ui:*` message bundle for the shared-ui renderer (`KbI18nProvider`). */
export function operatorUiMessages(locale: OperatorLocale): Record<string, string> {
  return buildUiMessageBundle(vocabularyCatalog, locale).messages;
}
