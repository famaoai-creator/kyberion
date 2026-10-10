/**
 * Linear XML-fragment helpers for the PPTX engine — indexOf scanners instead
 * of `<tag[^>]*>` / `[\s\S]*?` regexes (CodeQL polynomial-redos).
 */

function isTagBoundary(ch: string | undefined): boolean {
  return ch === '>' || ch === '/' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

/** First `<tag …>` element in either self-closing or open-close form. */
export function findXmlElement(
  xml: string,
  tag: string
): { start: number; end: number; outer: string } | null {
  const marker = `<${tag}`;
  let start = xml.indexOf(marker);
  while (start >= 0) {
    if (isTagBoundary(xml[start + marker.length])) {
      const openEnd = xml.indexOf('>', start);
      if (openEnd < 0) return null;
      if (xml[openEnd - 1] === '/') {
        return { start, end: openEnd + 1, outer: xml.slice(start, openEnd + 1) };
      }
      const close = xml.indexOf(`</${tag}>`, openEnd + 1);
      if (close < 0) return null;
      return {
        start,
        end: close + tag.length + 3,
        outer: xml.slice(start, close + tag.length + 3),
      };
    }
    start = xml.indexOf(marker, start + marker.length);
  }
  return null;
}

/** Replace `attr="…"` inside the FIRST `<tag …>` open tag (whitespace-prefixed attr). */
export function replaceXmlAttr(xml: string, tag: string, attr: string, value: string): string {
  const start = xml.indexOf(`<${tag}`);
  if (start < 0) return xml;
  const tagEnd = xml.indexOf('>', start);
  if (tagEnd < 0) return xml;
  const attrMarker = ` ${attr}="`;
  const attrStart = xml.indexOf(attrMarker, start);
  if (attrStart < 0 || attrStart > tagEnd) return xml;
  const valueStart = attrStart + attrMarker.length;
  const valueEnd = xml.indexOf('"', valueStart);
  if (valueEnd < 0 || valueEnd > tagEnd) return xml;
  return xml.slice(0, valueStart) + value + xml.slice(valueEnd);
}

/** Remove every self-closing `<tag …/>` occurrence. */
export function stripSelfClosingElements(xml: string, tag: string): string {
  const marker = `<${tag}`;
  const out: string[] = [];
  let cursor = 0;
  for (;;) {
    const start = xml.indexOf(marker, cursor);
    if (start < 0) break;
    const openEnd = xml.indexOf('>', start);
    const isMatch =
      openEnd >= 0 && xml[openEnd - 1] === '/' && isTagBoundary(xml[start + marker.length]);
    if (!isMatch) {
      out.push(xml.slice(cursor, start + marker.length));
      cursor = start + marker.length;
      continue;
    }
    out.push(xml.slice(cursor, start));
    cursor = openEnd + 1;
  }
  out.push(xml.slice(cursor));
  return out.join('');
}
