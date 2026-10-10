/**
 * Minimal deterministic HTML → Markdown conversion — the one HTML→text path
 * for reading files (`readDocument` format `html`, `pnpm kyberion read`) and
 * the ingest ceremony (`ingest:parse_document` format `html`).
 *
 * turndown is NOT vendored in this repo (checked 2026-07-28:
 * `require.resolve('turndown')` fails), so this is a conservative,
 * dependency-free tag handler covering p / h1-h6 / ul / ol / li / table /
 * a / pre / code / strong / em / br. Everything else is stripped to its
 * text content; <head>, <script>, <style> and comments are dropped. Output is
 * deterministic: no locale-, platform- or time-dependent behavior.
 */

import { decodeEntities } from './text-escaping.js';
import {
  elementBlocks,
  replaceElementBlocks,
  stripElementBlocks,
  stripTags,
} from './html-sanitize.js';

/** Remove comments with a linear scan — no regex backtracking on `<!--` runs. */
function stripComments(html: string): string {
  let out = html;
  let start = out.indexOf('<!--');
  while (start >= 0) {
    const end = out.indexOf('-->', start + 4);
    out = end < 0 ? out.slice(0, start) : out.slice(0, start) + out.slice(end + 3);
    start = out.indexOf('<!--');
  }
  return out;
}

/** Strip any remaining tags and collapse inline whitespace. */
function inlineText(html: string): string {
  return stripTags(html, '')
    .replace(/[ \t\r\n]+/g, ' ')
    .trim();
}

function convertInline(html: string): string {
  let out = html;
  out = replaceElementBlocks(out, 'a', (text, openTag) => {
    const href = /href="([^"]*)"/iu.exec(openTag)?.[1];
    return href === undefined ? openTag + text + '</a>' : `[${inlineText(text)}](${href})`;
  });
  for (const tag of ['strong', 'b']) {
    out = replaceElementBlocks(out, tag, (text) => `**${inlineText(text)}**`);
  }
  for (const tag of ['em', 'i']) {
    out = replaceElementBlocks(out, tag, (text) => `*${inlineText(text)}*`);
  }
  out = replaceElementBlocks(out, 'code', (text) => `\`${inlineText(text)}\``);
  return out;
}

function convertTable(tableHtml: string): string {
  const rows: string[][] = [];
  for (const rowHtml of elementBlocks(tableHtml, 'tr')) {
    const cells: string[] = [];
    const cellBlocks = [...elementBlocks(rowHtml, 'th'), ...elementBlocks(rowHtml, 'td')].sort(
      (a, b) => rowHtml.indexOf(a) - rowHtml.indexOf(b)
    );
    for (const cellHtml of cellBlocks) {
      const body = cellHtml.slice(cellHtml.indexOf('>') + 1, cellHtml.lastIndexOf('</'));
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
  const items = elementBlocks(listHtml, 'li');
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
  out = stripComments(out);
  out = stripElementBlocks(out, ['script', 'style', 'head'], '');

  // Protect <pre> blocks from inline/whitespace processing.
  const preBlocks: string[] = [];
  out = replaceElementBlocks(out, 'pre', (body) => {
    const code = decodeEntities(stripTags(body, '')).replace(/^\n+|\n+$/g, '');
    preBlocks.push(`\`\`\`\n${code}\n\`\`\``);
    return `\n\n@@KYB_PRE_${preBlocks.length - 1}@@\n\n`;
  });

  out = replaceElementBlocks(out, 'table', (inner, openTag, closeTag) =>
    convertTable(`${openTag}${inner}${closeTag}`)
  );
  out = replaceElementBlocks(out, 'ol', (inner, openTag, closeTag) =>
    convertList(`${openTag}${inner}${closeTag}`, true)
  );
  out = replaceElementBlocks(out, 'ul', (inner, openTag, closeTag) =>
    convertList(`${openTag}${inner}${closeTag}`, false)
  );

  for (let level = 1; level <= 6; level += 1) {
    out = replaceElementBlocks(
      out,
      `h${level}`,
      (text) => `\n\n${'#'.repeat(level)} ${inlineText(convertInline(text))}\n\n`
    );
  }
  out = replaceElementBlocks(out, 'p', (text) => `\n\n${inlineText(convertInline(text))}\n\n`);
  out = out.replace(/<br\s*\/?>/gi, '\n');
  out = out.replace(/<\/(div|section|article|blockquote)>/gi, '\n\n');

  out = convertInline(out);
  out = stripTags(out, '');
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

/** The document `<title>` (entities decoded, whitespace collapsed), if any. */
export function extractHtmlTitle(html: string): string | undefined {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(String(html ?? ''));
  const title = match ? decodeEntities(inlineText(match[1])) : '';
  return title || undefined;
}
