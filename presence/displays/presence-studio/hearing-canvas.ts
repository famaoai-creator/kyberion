// HT-02: model-generated hearing canvas. Scratch-first per AGENTS.md §2 —
// the look of the generated page is intentionally left to the model plus
// the design-defaults cascade (`resolveCreativeDesign`), never inline style
// literals authored here. This module stays pure except for
// `generateHearingCanvas`, which is the only place that calls the reasoning
// backend; everything it produces is sanitized before it is ever returned,
// and a sanitizer rejection or any failure falls back to the deterministic
// `renderHearingCanvas` template (HT-01) — the model never gets to bypass
// the fixed, escaped, external-resource-free canvas.
import { t as catalogT, type VocabularyKey } from '@agent/core/t';
import type { SupportedLocale } from '@agent/core/locale-normalize';
import { getReasoningBackend } from '@agent/core/reasoning-backend';
import {
  resolveCreativeDesign,
  type ResolvedCreativeDesign,
} from '@agent/core/creative-design-resolver';
import type { HearingRecord } from './hearing.js';
import { renderHearingCanvas } from './hearing-runtime.js';

export interface HearingCanvasSection {
  id: string;
  heading: string;
  body: string;
  answered: boolean;
}

/** Semantic brief only — no HTML, no styling. `locale` travels with the
 * brief so `buildHearingCanvasPrompt` can state the target language without
 * needing a third parameter. */
export interface HearingCanvasBrief {
  title: string;
  sections: HearingCanvasSection[];
  unanswered: string[];
  tone: 'plain';
  locale: SupportedLocale;
}

export function buildHearingCanvasBrief(
  record: HearingRecord,
  locale: SupportedLocale = 'en'
): HearingCanvasBrief {
  const unansweredLabel = catalogT('front_desk:hearing_canvas_unanswered', undefined, locale);
  const sections: HearingCanvasSection[] = record.requirements.map((item) => {
    const heading = catalogT(item.label_key as VocabularyKey, undefined, locale);
    const answered = Boolean(item.answer?.trim());
    return {
      id: item.id,
      heading,
      body: answered ? String(item.answer).trim() : unansweredLabel,
      answered,
    };
  });
  return {
    title: catalogT('front_desk:hearing_canvas_heading', undefined, locale),
    sections,
    unanswered: sections.filter((section) => !section.answered).map((section) => section.heading),
    tone: 'plain',
    locale,
  };
}

function designTokenCssVars(tokens: ResolvedCreativeDesign): string {
  return [
    `--color-primary: ${tokens.colors.primary};`,
    `--color-secondary: ${tokens.colors.secondary};`,
    `--color-accent: ${tokens.colors.accent};`,
    `--color-background: ${tokens.colors.background};`,
    `--color-text: ${tokens.colors.text};`,
    `--color-warning: ${tokens.colors.warning};`,
    `--font-heading: ${tokens.fonts.heading};`,
    `--font-body: ${tokens.fonts.body};`,
  ].join(' ');
}

/** Instruction text for the model. Asks for exactly one self-contained HTML
 * document, semantic markup only, no scripts/external resources/images/
 * links, and the given design tokens wired in as CSS custom properties —
 * never a per-element style literal chosen by us. */
export function buildHearingCanvasPrompt(
  brief: HearingCanvasBrief,
  tokens: ResolvedCreativeDesign
): string {
  const sectionLines = brief.sections
    .map(
      (section) =>
        `- ${section.heading} (${section.answered ? 'answered' : 'not answered yet'}): ${section.body}`
    )
    .join('\n');
  const openLines = brief.unanswered.length
    ? brief.unanswered.map((heading) => `- ${heading}`).join('\n')
    : 'None -- everything is answered.';
  return [
    'You are drafting a single-page visual summary of a requirements-gathering conversation.',
    `Write all visible text in this language: ${brief.locale}.`,
    'Output ONLY one self-contained HTML document and nothing else, in exactly this shape:',
    '<html><head><style>...</style></head><body>...</body></html>',
    'Use only semantic HTML elements (header, main, section, article, nav, aside, footer, h1-h4, p, ul, ol, li, table, thead, tbody, tr, th, td, blockquote, small, strong, em, span, div, hr, br).',
    'The document must contain no <script>, no event handler attributes, no external resources of any kind (no images, no fonts, no stylesheets or scripts fetched from a URL), no <a> links, no <iframe>/<object>/<embed>, and no <form>.',
    'Put ALL styling inline inside the single <style> tag in <head> — never inline style attributes on elements. Declare these CSS custom properties on :root and use var(...) to reference them instead of hardcoded colors or fonts:',
    `:root { ${designTokenCssVars(tokens)} }`,
    `Document title: ${brief.title}`,
    'Render one card or section per requirement below, clearly marking whether it is answered:',
    sectionLines,
    'Requirements still open (call these out distinctly, e.g. in a "still need" section):',
    openLines,
    'Keep the tone plain and factual. Do not invent facts beyond what is given above. Do not add a form or any input control -- this page is read-only.',
  ].join('\n');
}

export type SanitizedCanvasResult = { ok: true; html: string } | { ok: false; reason: string };

const MAX_CANVAS_HTML_BYTES = 200 * 1024;

const FORBIDDEN_CANVAS_PATTERNS: ReadonlyArray<{ reason: string; pattern: RegExp }> = [
  { reason: 'script_tag', pattern: /<script/i },
  { reason: 'event_handler_attribute', pattern: /\son[a-z]+\s*=/i },
  { reason: 'src_attribute', pattern: /\bsrc\s*=/i },
  { reason: 'href_attribute', pattern: /\bhref\s*=/i },
  { reason: 'http_url', pattern: /http:\/\//i },
  { reason: 'https_url', pattern: /https:\/\//i },
  { reason: 'javascript_protocol', pattern: /javascript:/i },
  { reason: 'css_import', pattern: /@import/i },
  { reason: 'css_url_function', pattern: /url\(/i },
  { reason: 'iframe_tag', pattern: /<iframe/i },
  { reason: 'object_tag', pattern: /<object/i },
  { reason: 'embed_tag', pattern: /<embed/i },
  { reason: 'form_tag', pattern: /<form/i },
  { reason: 'meta_http_equiv', pattern: /<meta\s+http-equiv/i },
];

/** Fixed tag allowlist (HT-02 deliverable). Anything else is stripped —
 * markup only, the surrounding text stays. */
const ALLOWED_CANVAS_TAGS = new Set([
  'html',
  'head',
  'style',
  'title',
  'body',
  'header',
  'main',
  'section',
  'article',
  'nav',
  'aside',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'p',
  'ul',
  'ol',
  'li',
  'strong',
  'em',
  'span',
  'div',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'hr',
  'br',
  'blockquote',
  'small',
]);

function stripDisallowedCanvasTags(html: string): string {
  return html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (match, rawName: string) =>
    ALLOWED_CANVAS_TAGS.has(rawName.toLowerCase()) ? match : ''
  );
}

/** Defense in depth after tag stripping: a bare `&` that is not already part
 * of an entity is escaped so it never gets reinterpreted as markup. */
function escapeStrayAmpersands(html: string): string {
  return html.replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;');
}

const SINGLE_HTML_DOCUMENT_PATTERN = /^(<!doctype\s+html\s*>)?\s*<html[\s>][\s\S]*<\/html>\s*$/i;

export function sanitizeGeneratedCanvasHtml(html: unknown): SanitizedCanvasResult {
  if (typeof html !== 'string' || !html.trim()) {
    return { ok: false, reason: 'empty' };
  }
  const trimmed = html.trim();
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_CANVAS_HTML_BYTES) {
    return { ok: false, reason: 'too_large' };
  }
  const openTagCount = (trimmed.match(/<html[\s>]/gi) || []).length;
  const closeTagCount = (trimmed.match(/<\/html>/gi) || []).length;
  if (openTagCount !== 1 || closeTagCount !== 1 || !SINGLE_HTML_DOCUMENT_PATTERN.test(trimmed)) {
    return { ok: false, reason: 'not_single_html_document' };
  }
  for (const { reason, pattern } of FORBIDDEN_CANVAS_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { ok: false, reason: `forbidden_pattern:${reason}` };
    }
  }
  const stripped = stripDisallowedCanvasTags(trimmed);
  return { ok: true, html: escapeStrayAmpersands(stripped) };
}

export interface HearingCanvasGenerationResult {
  source: 'generated' | 'template';
  html: string;
  reason?: string;
}

export interface HearingCanvasGenerationOptions {
  locale: SupportedLocale;
  tenantSlug?: string;
}

const HEARING_CANVAS_TIMEOUT_MS = 20_000;

/** `resolveCreativeDesign` throws on a malformed tenant slug (it is not
 * meant to be a lenient lookup) — a hearing namespace can be `'all'` /
 * `'unscoped'` rather than a real tenant, so we fall back to brand defaults
 * instead of letting that reject the whole generation. */
function resolveHearingCanvasTokens(tenantSlug: string | undefined): ResolvedCreativeDesign {
  try {
    return resolveCreativeDesign({ surface: 'web', tenantSlug, mode: 'light' });
  } catch {
    return resolveCreativeDesign({ surface: 'web', mode: 'light' });
  }
}

/** Never lets the caller hang: races the backend call against a timer that
 * aborts it. If the backend ignores the abort signal the race still settles
 * because the rejection comes from our own listener, not from the backend. */
function delegateCanvasPromptWithTimeout(
  prompt: string,
  context: string,
  timeoutMs: number
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const unref = (timer as unknown as { unref?: () => void }).unref;
  if (typeof unref === 'function') unref.call(timer);
  const timedOut = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => {
      reject(new Error(`[HEARING_CANVAS_TIMEOUT] generation exceeded ${timeoutMs}ms`));
    });
  });
  return Promise.race([
    getReasoningBackend().delegateTask(prompt, context, { signal: controller.signal }),
    timedOut,
  ]).finally(() => clearTimeout(timer));
}

/** Generate a model-drawn canvas for the current state of `record`. Always
 * resolves (never rejects) — any failure, timeout, or sanitizer rejection
 * yields the deterministic template result instead. Persistence is the
 * caller's job (`hearing-routes.ts`); this function never writes anything. */
export async function generateHearingCanvas(
  record: HearingRecord,
  options: HearingCanvasGenerationOptions
): Promise<HearingCanvasGenerationResult> {
  const { locale } = options;
  try {
    const tokens = resolveHearingCanvasTokens(options.tenantSlug);
    const brief = buildHearingCanvasBrief(record, locale);
    const prompt = buildHearingCanvasPrompt(brief, tokens);
    const raw = await delegateCanvasPromptWithTimeout(
      prompt,
      `hearing-canvas:${record.session_id}`,
      HEARING_CANVAS_TIMEOUT_MS
    );
    const sanitized = sanitizeGeneratedCanvasHtml(raw);
    if (sanitized.ok === false) {
      return {
        source: 'template',
        html: renderHearingCanvas(record, locale),
        reason: sanitized.reason,
      };
    }
    return { source: 'generated', html: sanitized.html };
  } catch (error) {
    return {
      source: 'template',
      html: renderHearingCanvas(record, locale),
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
