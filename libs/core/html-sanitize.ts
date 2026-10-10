/**
 * Iterative HTML → text stripping shared by surface/observation previews and
 * tag-stripping readers.
 *
 * Element-block removal and tag stripping run until stable so malformed
 * markup (`<<script>`, `</script foo>`) cannot leave a re-formed element or
 * tag behind — a single `replace` pass only removes the innermost match.
 * All scanning is indexOf-based (no lazy-quantifier regexes).
 */

function indexOfIgnoreCase(haystack: string, needle: string, from: number): number {
  const lowerNeedle = needle.toLowerCase();
  const limit = haystack.length - needle.length;
  for (let i = Math.max(0, from); i <= limit; i += 1) {
    if (haystack.slice(i, i + needle.length).toLowerCase() === lowerNeedle) return i;
  }
  return -1;
}

/**
 * Replace each complete `<tag …>inner</tag>` block via a linear scan —
 * equivalent to `/<tag\b[^>]*>([\s\S]*?)<\/tag[^>]*>/g.replace(cb)` but with
 * no lazy-quantifier backtracking. Close tags may carry attributes or
 * whitespace (`</script foo>`), matching the bad-tag-filter requirements.
 * Unclosed or unmatched markers are left as-is.
 */
export function replaceElementBlocks(
  html: string,
  tag: string,
  replace: (inner: string, openTag: string, closeTag: string) => string
): string {
  const openMarker = `<${tag}`;
  const closeMarker = `</${tag}`;
  const out: string[] = [];
  let cursor = 0;
  let searchFrom = 0;
  for (;;) {
    const start = indexOfIgnoreCase(html, openMarker, searchFrom);
    if (start < 0) break;
    const boundary = html[start + openMarker.length];
    if (
      boundary !== '>' &&
      boundary !== ' ' &&
      boundary !== '\t' &&
      boundary !== '\n' &&
      boundary !== '/' &&
      boundary !== '\r'
    ) {
      searchFrom = start + openMarker.length;
      continue;
    }
    const openEnd = html.indexOf('>', start);
    if (openEnd < 0) break;
    const closeStart = indexOfIgnoreCase(html, closeMarker, openEnd + 1);
    if (closeStart < 0) break;
    const closeEnd = html.indexOf('>', closeStart + closeMarker.length);
    if (closeEnd < 0) break;
    out.push(html.slice(cursor, start));
    out.push(
      replace(
        html.slice(openEnd + 1, closeStart),
        html.slice(start, openEnd + 1),
        html.slice(closeStart, closeEnd + 1)
      )
    );
    cursor = closeEnd + 1;
    searchFrom = cursor;
  }
  out.push(html.slice(cursor));
  return out.join('');
}

/** Collect each complete `<tag …>inner</tag>` block (outer text) via the same linear scan. */
export function elementBlocks(html: string, tag: string): string[] {
  const blocks: string[] = [];
  replaceElementBlocks(html, tag, (inner, openTag, closeTag) => {
    blocks.push(`${openTag}${inner}${closeTag}`);
    return '';
  });
  return blocks;
}

/** Remove `<tag>…</tag>` blocks (close-tag variants included) until none remain. */
export function stripElementBlocks(html: string, tags: string[], replacement = ' '): string {
  let out = html;
  for (const tag of tags) {
    let prev: string;
    do {
      prev = out;
      out = replaceElementBlocks(out, tag, () => replacement);
    } while (out !== prev);
  }
  return out;
}

/** Remove every `<…>` tag until stable. */
export function stripTags(html: string, replacement = ' '): string {
  let out = html;
  while (out.includes('<')) {
    const next = out.replace(/<[^<>]+>/g, replacement);
    if (next === out) break;
    out = next;
  }
  return out;
}

/** script/style blocks removed, then all remaining tags. */
export function htmlToPreviewText(html: string): string {
  return stripTags(stripElementBlocks(html, ['script', 'style']));
}
