/**
 * Prop hardening shared by every component. React already escapes text, so
 * the remaining injection vectors are URLs and the few free-form values that
 * reach attributes (column widths). Everything here is pure.
 */

import { safeHref as safeHrefVanilla } from '../vanilla/kyberion-ui.js';

/**
 * Return `href` when it is safe to put in an `<a href>`, otherwise `undefined`.
 * Allowed: same-origin paths (`/x`, `./x`, `x/y`, `#frag`, `?q`) and absolute
 * `http(s):` / `mailto:` / `tel:` URLs. Rejected: every other scheme
 * (`javascript:`, `data:`, `vbscript:`, ...), protocol-relative `//host`,
 * backslash tricks and control characters. Single source:
 * `libs/shared-ui/vanilla/kyberion-ui.js` (shared with the vanilla renderer).
 */
export function safeHref(href: unknown): string | undefined {
  return safeHrefVanilla(href) ?? undefined;
}

const CSS_LENGTH = /^(?:\d{1,4}(?:\.\d{1,2})?)(?:px|rem|em|ch|%)$/;

/** Accept only a plain CSS length for table column widths; anything else is dropped. */
export function safeCssLength(value: unknown): string | undefined {
  return typeof value === 'string' && CSS_LENGTH.test(value.trim()) ? value.trim() : undefined;
}

export function asArray<T>(value: T[] | undefined | null): T[] {
  return Array.isArray(value) ? value : [];
}

/** Display formatting for scalar cell / kv values. */
export function formatScalar(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'はい' : 'いいえ';
  return String(value);
}
