import vocabulary from '../../../../../knowledge/product/orchestration/user-facing-vocabulary.json';

/**
 * CS-04 (I18N-04): concierge strings live in the shared user-facing
 * vocabulary catalog under the `concierge` domain — the same single source
 * chronos uses — instead of a package-local messages.json. The JSON import
 * is client-safe (no node modules execute), mirroring
 * chronos-mirror-v2/src/lib/ux-vocabulary.ts and its rationale for not
 * importing `@agent/core/locale` here.
 */
const conciergeDomain = vocabulary.domains.concierge;

export type ConciergeLocale = 'en' | 'ja';
export type ConciergeMessageKey = keyof typeof conciergeDomain;
type MessageParams = Record<string, string | number>;

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
  const entry = conciergeDomain[key] as Record<string, string> | undefined;
  let value = entry?.[locale] || entry?.ja || entry?.en || String(key);
  for (const [name, replacement] of Object.entries(params)) {
    value = value.replaceAll(`{${name}}`, String(replacement));
  }
  return value;
}
