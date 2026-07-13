/**
 * AR-07: deterministic observation distillation for in-loop semantic
 * decisions. The rubric (llm-invocation-rubric.md) requires a deterministic
 * distillation step before `llm_decide` — same input, same output, bounded
 * size — so raw command output / HTTP responses never reach the model.
 *
 * Browser has distill_dom; these helpers cover the text (system/terminal)
 * and HTTP-response (network) observation families.
 */

export interface DistillTextOptions {
  maxHeadLines?: number;
  maxTailLines?: number;
  maxErrorLines?: number;
  maxLineChars?: number;
}

export interface DistilledTextObservation {
  total_lines: number;
  total_chars: number;
  truncated: boolean;
  head: string[];
  tail: string[];
  /** Lines matching common failure signatures, in order of appearance. */
  error_lines: string[];
}

const ERROR_LINE_PATTERN =
  /\b(error|err!|fail(?:ed|ure)?|exception|fatal|panic|denied|timeout|refused|unauthorized|not found)\b/i;

function clipLine(line: string, maxChars: number): string {
  return line.length > maxChars ? `${line.slice(0, maxChars)}…` : line;
}

export function distillTextObservation(
  text: string,
  options: DistillTextOptions = {}
): DistilledTextObservation {
  const maxHead = options.maxHeadLines ?? 20;
  const maxTail = options.maxTailLines ?? 20;
  const maxError = options.maxErrorLines ?? 10;
  const maxLineChars = options.maxLineChars ?? 200;

  const normalized = String(text ?? '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const head = lines.slice(0, maxHead).map((line) => clipLine(line, maxLineChars));
  const tail =
    lines.length > maxHead + maxTail
      ? lines.slice(-maxTail).map((line) => clipLine(line, maxLineChars))
      : lines.slice(maxHead).map((line) => clipLine(line, maxLineChars));
  const errorLines: string[] = [];
  for (const line of lines) {
    if (errorLines.length >= maxError) break;
    if (ERROR_LINE_PATTERN.test(line)) errorLines.push(clipLine(line.trim(), maxLineChars));
  }
  return {
    total_lines: lines.length,
    total_chars: normalized.length,
    truncated: lines.length > maxHead + maxTail,
    head,
    tail,
    error_lines: errorLines,
  };
}

export interface DistillHttpOptions {
  maxPreviewChars?: number;
  maxJsonKeys?: number;
  maxLinks?: number;
}

export interface DistilledHttpObservation {
  kind: 'json' | 'html' | 'text';
  total_chars: number;
  truncated: boolean;
  /** Top-level keys (object) or `[N items]` marker (array) for JSON bodies. */
  json_shape?: string[];
  /** <title> text for HTML bodies. */
  title?: string;
  /** First hrefs for HTML bodies (bounded). */
  links?: string[];
  text_preview: string;
}

export function distillHttpResponse(
  body: unknown,
  options: DistillHttpOptions = {}
): DistilledHttpObservation {
  const maxPreview = options.maxPreviewChars ?? 2000;
  const maxJsonKeys = options.maxJsonKeys ?? 30;
  const maxLinks = options.maxLinks ?? 15;

  if (body !== null && typeof body === 'object') {
    const serialized = JSON.stringify(body);
    const shape = Array.isArray(body)
      ? [`[array of ${body.length} item(s)]`]
      : Object.keys(body as Record<string, unknown>).slice(0, maxJsonKeys);
    return {
      kind: 'json',
      total_chars: serialized.length,
      truncated: serialized.length > maxPreview,
      json_shape: shape,
      text_preview: serialized.slice(0, maxPreview),
    };
  }

  const text = String(body ?? '');
  const looksHtml = /<html[\s>]|<!doctype html/i.test(text);
  if (looksHtml) {
    const title = text.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim();
    const links: string[] = [];
    for (const match of text.matchAll(/href="([^"#][^"]*)"/gi)) {
      if (links.length >= maxLinks) break;
      links.push(match[1]);
    }
    const stripped = text
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return {
      kind: 'html',
      total_chars: text.length,
      truncated: stripped.length > maxPreview,
      ...(title ? { title } : {}),
      links,
      text_preview: stripped.slice(0, maxPreview),
    };
  }

  return {
    kind: 'text',
    total_chars: text.length,
    truncated: text.length > maxPreview,
    text_preview: text.slice(0, maxPreview),
  };
}
