/**
 * PH-02: static checks for `sandboxed-iframe` plugin views.
 *
 * An iframe view is one self-contained `views/*.html` document served by the
 * host with a sandbox + deny-by-default CSP (`pluginViewFrameResponseHeaders`).
 * The CSP and the iframe sandbox are the real defence; the scan here only
 * rejects obvious remote loads early so an author gets a clear
 * `[PLUGIN_VIEW_INVALID]` instead of a silently broken view:
 *
 *   - `<base` elements and `http-equiv` meta directives;
 *   - URL-bearing attributes (`src`, `href`, `srcset`, `action`, ...) whose
 *     value starts with `http:`, `https:` or a protocol-relative `//`.
 *
 * Every scan is linear (bounded look-behind / look-ahead, no regex over the
 * untrusted document). This module is pure: no I/O, no host state.
 */

/** Maximum size of an iframe view document (UTF-8 bytes). */
export const PLUGIN_VIEW_FRAME_MAX_BYTES = 512 * 1024;

/** The only capability a plugin view may request: send action requests to the host. */
export const PLUGIN_VIEW_ACTION_REQUEST_CAPABILITY = 'action.request';

/** postMessage protocol id shared by the host broker and plugin frames. */
export const PLUGIN_VIEW_FRAME_PROTOCOL = 'kyberion.plugin-view/1';

const FRAME_DOCUMENT_PATH = /^views\/[a-z0-9][a-z0-9_-]{0,63}\.html$/u;

const URL_ATTRIBUTES = new Set([
  'src',
  'href',
  'srcset',
  'imagesrcset',
  'action',
  'formaction',
  'poster',
  'data',
  'background',
  'ping',
  'manifest',
  'xlink:href',
]);
const MAX_ATTRIBUTE_NAME = 16;
const URL_PREFIX_WINDOW = 128;
const SRCSET_WINDOW = 1024;

export function isPluginViewFrameDocumentPath(relative: string): boolean {
  return FRAME_DOCUMENT_PATH.test(relative);
}

/** True when a view declaration may send `action.request` messages to the host. */
export function pluginViewMaySendActions(declaration: {
  capabilities: readonly string[];
  actions: readonly unknown[];
}): boolean {
  return (
    declaration.capabilities.includes(PLUGIN_VIEW_ACTION_REQUEST_CAPABILITY) &&
    declaration.actions.length > 0
  );
}

function isSpace(char: string | undefined): boolean {
  return (
    char === ' ' ||
    char === '\t' ||
    char === '\n' ||
    char === '\r' ||
    char === '\f' ||
    char === '\v'
  );
}

function isNameChar(char: string | undefined): boolean {
  return (
    char !== undefined &&
    ((char >= 'a' && char <= 'z') ||
      (char >= '0' && char <= '9') ||
      char === '-' ||
      char === '_' ||
      char === ':')
  );
}

function containsBaseElement(lower: string): boolean {
  let index = lower.indexOf('<');
  while (index !== -1) {
    let cursor = index + 1;
    while (isSpace(lower[cursor])) cursor += 1;
    if (lower.startsWith('base', cursor) && !isNameChar(lower[cursor + 4])) return true;
    index = lower.indexOf('<', index + 1);
  }
  return false;
}

/** Attribute value starting at `start`, bounded to `limit` characters. */
function attributeValue(lower: string, start: number, quote: string | undefined, limit: number) {
  const max = Math.min(lower.length, start + limit);
  let cursor = start;
  while (cursor < max) {
    const char = lower[cursor];
    if (quote ? char === quote : isSpace(char) || char === '>') break;
    cursor += 1;
  }
  return lower.slice(start, cursor);
}

const NAMED_URL_ENTITIES: Record<string, string> = {
  colon: ':',
  sol: '/',
  bsol: '\\',
  tab: '\t',
  newline: '\n',
};

/** Decodes numeric and URL-relevant named character references (linear). */
function decodeCharacterReferences(value: string): string {
  let out = '';
  let cursor = 0;
  while (cursor < value.length) {
    const char = value[cursor]!;
    const semicolon = char === '&' ? value.indexOf(';', cursor) : -1;
    if (semicolon > cursor && semicolon - cursor <= 32) {
      const body = value.slice(cursor + 1, semicolon);
      let decoded: string | undefined = NAMED_URL_ENTITIES[body];
      if (decoded === undefined && body.startsWith('#')) {
        const hex = body[1] === 'x';
        const digits = body.slice(hex ? 2 : 1);
        const code = Number.parseInt(digits, hex ? 16 : 10);
        if (digits.length > 0 && Number.isFinite(code) && code > 0 && code < 0x110000) {
          decoded = String.fromCodePoint(code).toLowerCase();
        }
      }
      if (decoded !== undefined) {
        out += decoded;
        cursor = semicolon + 1;
        continue;
      }
    }
    out += char;
    cursor += 1;
  }
  return out;
}

/** Browsers drop ASCII tab/newline anywhere in a URL and trim leading C0/space. */
function isRemoteUrl(raw: string): boolean {
  let prefix = '';
  for (const char of decodeCharacterReferences(raw)) {
    if (char === '\t' || char === '\n' || char === '\r') continue;
    if (prefix.length === 0 && char <= ' ') continue;
    prefix += char;
    if (prefix.length >= 6) break;
  }
  if (prefix.startsWith('http:') || prefix.startsWith('https:')) return true;
  const head = prefix.slice(0, 2);
  return head === '//' || head === '\\\\' || head === '/\\' || head === '\\/';
}

/** Name of the attribute an `=` at `index` belongs to (bounded look-behind). */
function attributeNameBefore(lower: string, index: number): string {
  let cursor = index - 1;
  while (cursor >= 0 && index - cursor <= 4 && isSpace(lower[cursor])) cursor -= 1;
  const end = cursor + 1;
  while (cursor >= 0 && end - cursor <= MAX_ATTRIBUTE_NAME && isNameChar(lower[cursor])) {
    cursor -= 1;
  }
  if (end - cursor > MAX_ATTRIBUTE_NAME) return '';
  const before = lower[cursor];
  if (cursor >= 0 && !isSpace(before) && before !== '"' && before !== "'" && before !== '/') {
    return '';
  }
  return lower.slice(cursor + 1, end);
}

function remoteAttribute(lower: string): string | undefined {
  let index = lower.indexOf('=');
  while (index !== -1) {
    const name = attributeNameBefore(lower, index);
    if (URL_ATTRIBUTES.has(name)) {
      let cursor = index + 1;
      while (cursor - index <= 4 && isSpace(lower[cursor])) cursor += 1;
      const open = lower[cursor];
      const quote = open === '"' || open === "'" || open === '`' ? open : undefined;
      const start = quote ? cursor + 1 : cursor;
      const remote =
        name === 'srcset' || name === 'imagesrcset'
          ? attributeValue(lower, start, quote, SRCSET_WINDOW).split(',').some(isRemoteUrl)
          : isRemoteUrl(attributeValue(lower, start, quote, URL_PREFIX_WINDOW));
      if (remote) return name;
    }
    index = lower.indexOf('=', index + 1);
  }
  return undefined;
}

/**
 * Returns why `html` must not be served as an iframe view, or undefined when
 * it passes the early checks. Size is measured in UTF-8 bytes.
 */
export function findPluginViewFrameViolation(html: string): string | undefined {
  if (Buffer.byteLength(html, 'utf8') > PLUGIN_VIEW_FRAME_MAX_BYTES) {
    return `exceeds ${PLUGIN_VIEW_FRAME_MAX_BYTES} bytes`;
  }
  if (html.includes('\u0000')) return 'contains NUL characters';
  const lower = html.toLowerCase();
  if (containsBaseElement(lower)) return '<base> elements are not allowed';
  if (lower.includes('http-equiv')) return 'http-equiv directives are not allowed';
  const attribute = remoteAttribute(lower);
  if (attribute) return `attribute '${attribute}' loads a remote (http/https) URL`;
  return undefined;
}

/**
 * Decodes an iframe view document as strict UTF-8. Throws when it is larger
 * than the limit or not valid UTF-8 (the byte limit is checked first).
 */
export function decodePluginViewFrameHtml(bytes: Uint8Array): string {
  if (bytes.byteLength > PLUGIN_VIEW_FRAME_MAX_BYTES) {
    throw new Error(`exceeds ${PLUGIN_VIEW_FRAME_MAX_BYTES} bytes`);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new Error('is not valid UTF-8');
  }
}

/**
 * Response headers a surface must send with an iframe view document. The
 * CSP `sandbox` directive re-applies the iframe sandbox even when the
 * document is opened directly (opaque origin, scripts only).
 */
export function pluginViewFrameResponseHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': [
      'sandbox allow-scripts',
      "default-src 'none'",
      "script-src 'unsafe-inline'",
      "style-src 'unsafe-inline'",
      'img-src data:',
      'font-src data:',
      "connect-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      "frame-ancestors 'self'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': [
      'accelerometer=()',
      'autoplay=()',
      'camera=()',
      'clipboard-read=()',
      'clipboard-write=()',
      'display-capture=()',
      'fullscreen=()',
      'geolocation=()',
      'gyroscope=()',
      'magnetometer=()',
      'microphone=()',
      'midi=()',
      'payment=()',
      'usb=()',
    ].join(', '),
  };
}
