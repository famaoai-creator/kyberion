/** Escape text for interpolation into HTML content or attributes. */
export function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/** Escape text for XML content or attributes. */
export function escapeXml(value: string): string {
  return String(value).replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&apos;';
    }
  });
}

/** Remove XML 1.0 control characters that cannot appear in Office XML parts. */
export function stripXmlControlCharacters(value: string): string {
  return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, '');
}

/** Strip control characters, then escape — one step for Office XML text. */
export function sanitizeXmlText(value: string): string {
  return escapeXml(stripXmlControlCharacters(value));
}

const BASIC_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&nbsp;': ' ',
};

/**
 * Decode HTML/XML entities in a single pass. The alternation consumes `&amp;`
 * before looking at what follows it, so `&amp;lt;` decodes once to `&lt;`
 * instead of being unescaped twice into `<`.
 */
export function decodeEntities(value: string): string {
  return String(value).replace(
    /&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gu,
    (entity, body: string) => {
      if (body.startsWith('#x')) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
      if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
      return BASIC_ENTITIES[`&${body};`] ?? entity;
    }
  );
}
