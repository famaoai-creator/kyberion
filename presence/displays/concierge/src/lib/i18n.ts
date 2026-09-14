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
/**
 * FD-00c: the shared front-desk rail domain (`front_desk:*`), rendered by
 * `FrontDeskRail` / `CommandPalette`. Kept as its own type rather than
 * folded into `ConciergeMessageKey` — the two domains are populated
 * separately (FD-00a owns the `front_desk` catalog) and widening
 * `ConciergeMessageKey` would let concierge-only call sites silently accept
 * front-desk keys that were never meant for the `concierge` domain.
 */
export type FrontDeskMessageKey = keyof (typeof vocabulary)['domains']['front_desk'];
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

/** FD-00c: renders a `front_desk:*` vocabulary key for the shared rail. */
export function frontDeskText(
  key: FrontDeskMessageKey,
  locale: ConciergeLocale,
  params: MessageParams = {}
): string {
  return browserVocabulary.renderMessage(`front_desk:${String(key)}`, params, locale);
}
