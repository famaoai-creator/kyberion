import * as React from 'react';

/**
 * A small, dependency-free Markdown renderer for chat messages. It builds React
 * elements (never HTML strings), so text can not inject markup; links are
 * limited to http(s) and mailto and open safely.
 *
 * Supported: fenced code blocks, headings, bullet and numbered lists,
 * blockquotes, paragraphs, **bold**, *italic*, `code`, and [links](url).
 */

const SAFE_URL = /^(https?:\/\/|mailto:)/iu;

export function isSafeMarkdownUrl(url: string): boolean {
  return SAFE_URL.test(url.trim());
}

const INLINE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^)\s]+\))/u;

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let rest = text;
  let index = 0;
  while (rest.length > 0) {
    const match = INLINE.exec(rest);
    if (!match) {
      nodes.push(rest);
      break;
    }
    if (match.index > 0) nodes.push(rest.slice(0, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${index++}`;
    if (token.startsWith('`')) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{renderInline(token.slice(2, -2), key)}</strong>);
    } else if (token.startsWith('*')) {
      nodes.push(<em key={key}>{renderInline(token.slice(1, -1), key)}</em>);
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/u.exec(token);
      if (link && isSafeMarkdownUrl(link[2])) {
        nodes.push(
          <a key={key} href={link[2]} target="_blank" rel="noopener noreferrer">
            {link[1]}
          </a>
        );
      } else {
        nodes.push(token);
      }
    }
    rest = rest.slice(match.index + token.length);
  }
  return nodes;
}

export type MarkdownBlock =
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'paragraph'; text: string };

/** Split a message into blocks. Exported for tests and for the copy-code affordance. */
export function parseMarkdownBlocks(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/gu, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^```(\w*)\s*$/u.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/u.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (or end of text while still streaming)
      blocks.push({ kind: 'code', lang: fence[1], text: body.join('\n') });
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/u.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }
    if (/^>\s?/u.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/u.test(lines[i]))
        quote.push(lines[i++].replace(/^>\s?/u, ''));
      blocks.push({ kind: 'quote', text: quote.join('\n') });
      continue;
    }
    const bullet = /^\s*[-*]\s+/u;
    const numbered = /^\s*\d+[.)]\s+/u;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const matcher = ordered ? numbered : bullet;
      const items: string[] = [];
      while (i < lines.length && matcher.test(lines[i]))
        items.push(lines[i++].replace(matcher, ''));
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }
    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^```/u.test(lines[i]) &&
      !/^(#{1,4})\s+/u.test(lines[i]) &&
      !/^>\s?/u.test(lines[i]) &&
      !bullet.test(lines[i]) &&
      !numbered.test(lines[i])
    ) {
      paragraph.push(lines[i++]);
    }
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
  }
  return blocks;
}

export function Markdown({
  source,
  copyLabel,
  copiedLabel,
}: {
  source: string;
  copyLabel?: string;
  copiedLabel?: string;
}) {
  const blocks = React.useMemo(() => parseMarkdownBlocks(source), [source]);
  return (
    <div className="md">
      {blocks.map((block, index) => {
        const key = `b${index}`;
        switch (block.kind) {
          case 'code':
            return (
              <CodeBlock
                key={key}
                lang={block.lang}
                text={block.text}
                copyLabel={copyLabel}
                copiedLabel={copiedLabel}
              />
            );
          case 'heading': {
            const level = Math.min(4, Math.max(1, block.level)) + 2; // h3..h6: chat headings stay small
            return React.createElement(`h${level}`, { key }, renderInline(block.text, key));
          }
          case 'quote':
            return <blockquote key={key}>{renderInline(block.text, key)}</blockquote>;
          case 'list': {
            const Tag = block.ordered ? 'ol' : 'ul';
            return (
              <Tag key={key}>
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>
                ))}
              </Tag>
            );
          }
          default:
            return <p key={key}>{renderInline(block.text, key)}</p>;
        }
      })}
    </div>
  );
}

function CodeBlock({
  lang,
  text,
  copyLabel,
  copiedLabel,
}: {
  lang: string;
  text: string;
  copyLabel?: string;
  copiedLabel?: string;
}) {
  const [copied, setCopied] = React.useState(false);
  return (
    <div className="md-code">
      <div className="md-code__bar">
        <span>{lang || 'text'}</span>
        {copyLabel ? (
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(text).then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1400);
              });
            }}
          >
            {copied ? copiedLabel : copyLabel}
          </button>
        ) : null}
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}
