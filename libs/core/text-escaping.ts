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
