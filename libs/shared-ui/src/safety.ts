/**
 * Prop hardening shared by every component. React already escapes text, so
 * the remaining injection vectors are URLs and the few free-form values that
 * reach attributes (column widths). Everything here is pure.
 */

const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * Return `href` when it is safe to put in an `<a href>`, otherwise `undefined`.
 * Allowed: same-origin paths (`/x`, `./x`, `x/y`, `#frag`, `?q`) and absolute
 * `http(s):` / `mailto:` URLs. Rejected: every other scheme (`javascript:`,
 * `data:`, `vbscript:`, ...), protocol-relative `//host`, backslash tricks and
 * control characters (which browsers strip before parsing the scheme).
 */
export function safeHref(href: unknown): string | undefined {
  if (typeof href !== 'string') return undefined;
  const value = href.trim();
  if (!value || value.length > 2048 || CONTROL_CHARS.test(value)) return undefined;
  if (value.startsWith('//') || value.startsWith('/\\') || value.startsWith('\\')) return undefined;
  if (SCHEME_PREFIX.test(value)) {
    try {
      return SAFE_SCHEMES.has(new URL(value).protocol) ? value : undefined;
    } catch {
      return undefined;
    }
  }
  return value;
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
