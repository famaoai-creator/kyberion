/**
 * Locale helpers for the unified local-pads desk (PA-07).
 *
 * Every user-visible string of the desk lives in the `personal_pads`
 * vocabulary domain. Definitions (registry, adapters, actions) hold keys;
 * they are resolved per request locale — never the process default — by
 * the transport (`resolvePadLocale(req)` in `server.ts`).
 */
import type { SupportedLocale } from '@agent/core/locale-normalize';
import { resolveLocale } from '@agent/core/locale';
import type { VocabularyKey } from '@agent/core/t';
import { padT, padTexts, type PadTranslator } from '../lib/pad-ui.js';

export type { PadTranslator };

/** The locale used when a caller (legacy CLI, tests) passes none. */
export function defaultPadLocale(locale?: SupportedLocale): SupportedLocale {
  return locale ?? resolveLocale();
}

/** A translator (params interpolated) bound to `locale`. */
export function padsT(locale?: SupportedLocale): PadTranslator {
  return padT(defaultPadLocale(locale));
}

/** Raw catalog text with `{placeholders}` kept (templates are interpolated by the adapter). */
export function padsText(key: VocabularyKey, locale?: SupportedLocale): string {
  return padTexts([key], defaultPadLocale(locale))[key];
}
