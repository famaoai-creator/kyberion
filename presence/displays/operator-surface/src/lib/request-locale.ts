import { cookies, headers } from 'next/headers';
import { OPERATOR_DEFAULT_LOCALE, normalizeOperatorLocale, type OperatorLocale } from './i18n';
import { UI_LOCALE_COOKIE } from './display-preferences';

/**
 * Server-side locale for a page render: the viewer's `kb-ui-locale` cookie
 * (written by the language control, shared with the front-desk surfaces),
 * else the browser's Accept-Language, else Japanese. Presentation only — it
 * never affects tenant scope or what data is read.
 */
export async function getRequestLocale(): Promise<OperatorLocale> {
  const jar = await cookies();
  const fromCookie = normalizeOperatorLocale(jar.get(UI_LOCALE_COOKIE)?.value);
  if (fromCookie) return fromCookie;
  const accept = (await headers()).get('accept-language') || '';
  const first = accept.split(',')[0] || '';
  return normalizeOperatorLocale(first) ?? OPERATOR_DEFAULT_LOCALE;
}
