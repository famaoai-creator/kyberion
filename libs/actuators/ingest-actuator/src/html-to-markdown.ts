/**
 * Minimal deterministic HTML → Markdown conversion for ingest parsing.
 *
 * turndown is NOT vendored in this repo (checked 2026-07-28:
 * `require.resolve('turndown')` fails), so this is a conservative,
 * dependency-free tag handler covering p / h1-h6 / ul / ol / li / table /
 * a / pre / code / strong / em / br. Everything else is stripped to its
 * text content. Output is deterministic: no locale-, platform- or
 * time-dependent behavior.
 */

const BASIC_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (entity) => BASIC_ENTITIES[entity] ?? entity);
}

/** Strip any remaining tags and collapse inline whitespace. */
function inlineText(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/[ \t\r\n]+/g, ' ')
    .trim();
}

function convertInline(html: string): string {
  let out = html;
  out = out.replace(
    /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_, href: string, text: string) => `[${inlineText(text)}](${href})`
  );
  out = out.replace(
    /<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi,
    (_, _tag: string, text: string) => `**${inlineText(text)}**`
  );
  out = out.replace(
    /<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi,
    (_, _tag: string, text: string) => `*${inlineText(text)}*`
  );
  out = out.replace(
    /<code\b[^>]*>([\s\S]*?)<\/code>/gi,
    (_, text: string) => `\`${inlineText(text)}\``
  );
  return out;
}

function convertTable(tableHtml: string): string {
  const rows: string[][] = [];
  const rowMatches = tableHtml.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) ?? [];
  for (const rowHtml of rowMatches) {
    const cells: string[] = [];
    const cellMatches = rowHtml.match(/<(th|td)\b[^>]*>[\s\S]*?<\/\1>/gi) ?? [];
    for (const cellHtml of cellMatches) {
      const body = cellHtml.replace(/^<(th|td)\b[^>]*>/i, '').replace(/<\/(th|td)>$/i, '');
      cells.push(inlineText(convertInline(body)).replace(/\|/g, '\\|'));
    }
    if (cells.length > 0) rows.push(cells);
  }
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map((row) => row.length));
  const pad = (row: string[]) => Array.from({ length: width }, (_, i) => row[i] ?? '');
  const lines = [
    `| ${pad(rows[0]).join(' | ')} |`,
    `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
    ...rows.slice(1).map((row) => `| ${pad(row).join(' | ')} |`),
  ];
  return `\n\n${lines.join('\n')}\n\n`;
}

function convertList(listHtml: string, ordered: boolean): string {
  const items = listHtml.match(/<li\b[^>]*>[\s\S]*?<\/li>/gi) ?? [];
  const lines = items.map((itemHtml, index) => {
    const body = itemHtml.replace(/^<li\b[^>]*>/i, '').replace(/<\/li>$/i, '');
    const marker = ordered ? `${index + 1}.` : '-';
    return `${marker} ${inlineText(convertInline(body))}`;
  });
  return lines.length > 0 ? `\n\n${lines.join('\n')}\n\n` : '';
}

export function htmlToMarkdown(html: string): string {
  let out = String(html ?? '');

  // Drop non-content blocks entirely.
  out = out.replace(/<!--[\s\S]*?-->/g, '');
  out = out.replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, '');

  // Protect <pre> blocks from inline/whitespace processing.
  const preBlocks: string[] = [];
  out = out.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, body: string) => {
    const code = decodeEntities(body.replace(/<[^>]*>/g, '')).replace(/^\n+|\n+$/g, '');
    preBlocks.push(`\`\`\`\n${code}\n\`\`\``);
    return `\n\n@@KYB_PRE_${preBlocks.length - 1}@@\n\n`;
  });

  out = out.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (table) => convertTable(table));
  out = out.replace(/<ol\b[^>]*>[\s\S]*?<\/ol>/gi, (list) => convertList(list, true));
  out = out.replace(/<ul\b[^>]*>[\s\S]*?<\/ul>/gi, (list) => convertList(list, false));

  out = out.replace(
    /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_, level: string, text: string) =>
      `\n\n${'#'.repeat(Number(level))} ${inlineText(convertInline(text))}\n\n`
  );
  out = out.replace(
    /<p\b[^>]*>([\s\S]*?)<\/p>/gi,
    (_, text: string) => `\n\n${inlineText(convertInline(text))}\n\n`
  );
  out = out.replace(/<br\s*\/?>/gi, '\n');
  out = out.replace(/<\/(div|section|article|blockquote)>/gi, '\n\n');

  out = convertInline(out);
  out = out.replace(/<[^>]*>/g, '');
  out = decodeEntities(out);

  // Whitespace normalization: per-line trim, collapse 3+ newlines to 2.
  out = out
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, '').replace(/^[ \t]+/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Restore protected <pre> blocks.
  out = out.replace(/@@KYB_PRE_(\d+)@@/g, (_, index: string) => preBlocks[Number(index)] ?? '');

  return out;
}
