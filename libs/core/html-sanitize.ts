/**
 * Iterative HTML → text stripping shared by surface/observation previews.
 *
 * Element-block removal and tag stripping run until stable so malformed
 * markup (`<<script>`, `</script foo>`) cannot leave a re-formed element or
 * tag behind — a single `replace` pass only removes the innermost match.
 */

/** Remove `<tag>…</tag>` blocks (close-tag variants included) until none remain. */
export function stripElementBlocks(html: string, tags: string[]): string {
  const pattern = new RegExp(`<(${tags.join('|')})\\b[^>]*>[\\s\\S]*?<\\/\\1[^>]*>`, 'gi');
  let out = html;
  let prev: string;
  do {
    prev = out;
    out = out.replace(pattern, ' ');
  } while (out !== prev);
  return out;
}

/** Remove every `<…>` tag until stable. */
export function stripTags(html: string): string {
  let out = html;
  while (out.includes('<')) {
    const next = out.replace(/<[^<>]+>/g, ' ');
    if (next === out) break;
    out = next;
  }
  return out;
}

/** script/style blocks removed, then all remaining tags. */
export function htmlToPreviewText(html: string): string {
  return stripTags(stripElementBlocks(html, ['script', 'style']));
}
