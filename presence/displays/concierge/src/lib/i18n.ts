import type vocabulary from '../../../../../knowledge/product/orchestration/user-facing-vocabulary.json';
import vocabularyCatalog from '../../../../../knowledge/product/orchestration/user-facing-vocabulary.json';
import { createBrowserVocabularyResolver } from '@agent/core/locale-normalize';

/**
 * CS-04 (I18N-04): concierge strings live in the shared user-facing
 * vocabulary catalog under the `concierge` domain — the same single source
 * chronos uses — instead of a package-local messages.json. The JSON import
 * is client-safe (no node modules execute), mirroring
 * chronos-mirror-v2/src/lib/ux-vocabulary.ts and its rationale for not
 * importing `@agent/core/locale` here.
 */
export type ConciergeLocale = 'en' | 'ja';
export type ConciergeMessageKey = keyof (typeof vocabulary)['domains']['concierge'];
type MessageParams = Record<string, string | number>;
const browserVocabulary = createBrowserVocabularyResolver(vocabularyCatalog);

export function resolveConciergeLocale(value?: string): ConciergeLocale {
  return value?.toLowerCase().startsWith('en') ? 'en' : 'ja';
}

export function detectConciergeLocale(): ConciergeLocale {
  if (typeof navigator === 'undefined') return 'ja';
  return resolveConciergeLocale(navigator.language);
}

export function conciergeText(
  key: ConciergeMessageKey,
  locale: ConciergeLocale,
  params: MessageParams = {}
): string {
  return browserVocabulary.renderMessage(`concierge:${String(key)}`, params, locale);
}
