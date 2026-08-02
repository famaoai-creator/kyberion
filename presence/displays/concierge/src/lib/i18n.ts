import messages from './messages.json';

export type ConciergeLocale = 'en' | 'ja';
export type ConciergeMessageKey = keyof typeof messages;
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
  const entry = messages[key] as Record<string, string>;
  let value = entry[locale] || entry.ja || entry.en || key;
  for (const [name, replacement] of Object.entries(params)) {
    value = value.replaceAll(`{${name}}`, String(replacement));
  }
  return value;
}
