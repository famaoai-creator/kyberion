/**
 * The page template filled with the `customer_room` vocabulary (every locale,
 * so the page can switch to the agenda's language after the view loads).
 * Pure apart from the catalog read it is handed.
 */
export type CustomerRoomLocale = 'en' | 'ja';
export type CustomerRoomBundles = Record<CustomerRoomLocale, Record<string, string>>;

export const CUSTOMER_ROOM_DOMAIN = 'customer_room';

export interface VocabularyDomainSource {
  domains?: Record<string, Record<string, Record<string, string>> | undefined>;
}

export function buildBundles(catalog: VocabularyDomainSource | null): CustomerRoomBundles {
  const bundles: CustomerRoomBundles = { en: {}, ja: {} };
  const domain = catalog?.domains?.[CUSTOMER_ROOM_DOMAIN] ?? {};
  for (const [key, entry] of Object.entries(domain)) {
    for (const locale of ['en', 'ja'] as const) {
      const text = entry[locale] ?? entry.en;
      if (typeof text === 'string') bundles[locale][key] = text;
    }
  }
  return bundles;
}

const LOCALES: readonly CustomerRoomLocale[] = ['en', 'ja'];

/** The first supported language in `Accept-Language`, else English. */
export function localeFromAcceptLanguage(header: string | undefined): CustomerRoomLocale {
  for (const part of (header ?? '').split(',')) {
    const base = part.split(';')[0].trim().toLowerCase().split('-')[0];
    const found = LOCALES.find((locale) => locale === base);
    if (found) return found;
  }
  return LOCALES[0];
}

/** JSON that is safe inside a `<script type="application/json">` block. */
export function toInlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</gu, '\\u003c')
    .replace(/>/gu, '\\u003e')
    .replace(/&/gu, '\\u0026')
    .replace(/[\u2028]/gu, '\\u2028')
    .replace(/[\u2029]/gu, '\\u2029');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

export function renderCustomerRoomPage(
  template: string,
  bundles: CustomerRoomBundles,
  acceptLanguage: string | undefined
): string {
  const locale = localeFromAcceptLanguage(acceptLanguage);
  return template
    .replace(/\{\{locale\}\}/gu, locale)
    .replace(/\{\{page-title\}\}/gu, () => escapeHtml(bundles[locale].page_title ?? ''))
    .replace(/\{\{vocabulary-json\}\}/gu, () => toInlineJson(bundles));
}
