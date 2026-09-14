// HT-02: pure semantic-brief/prompt/sanitizer unit tests plus
// `generateHearingCanvas` behavior under the stub backend, a fake backend
// returning a clean/dirty document, and a backend that never resolves
// (timeout path, via fake timers).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t as catalogT } from '@agent/core/t';
import {
  registerReasoningBackend,
  resetReasoningBackend,
  stubReasoningBackend,
} from '@agent/core/reasoning-backend';
import { applyHearingTurn, createHearingRecord, type HearingRecord } from './hearing.js';
import {
  buildHearingCanvasBrief,
  buildHearingCanvasPrompt,
  generateHearingCanvas,
  sanitizeGeneratedCanvasHtml,
} from './hearing-canvas.js';

function fixtureRecord(): HearingRecord {
  const created = createHearingRecord('hearing-canvas-fixture', '2026-09-14T00:00:00.000Z');
  return applyHearingTurn(
    created,
    { text: 'Freelancers booking studio time.', request_id: 'turn-1' },
    '2026-09-14T00:01:00.000Z'
  );
}

const CLEAN_DOCUMENT =
  '<html><head><style>:root{--color-primary:#111;}</style></head>' +
  '<body><main><h1>Draft</h1><section><h2>Who it is for</h2><p>Freelancers</p></section></main></body></html>';

afterEach(() => {
  resetReasoningBackend();
});

describe('buildHearingCanvasBrief', () => {
  it('builds one section per requirement with vocabulary-resolved headings and marks answered state', () => {
    const record = fixtureRecord();
    const brief = buildHearingCanvasBrief(record, 'en');

    expect(brief.tone).toBe('plain');
    expect(brief.locale).toBe('en');
    expect(brief.title).toBe(catalogT('front_desk:hearing_canvas_heading', undefined, 'en'));
    expect(brief.sections).toHaveLength(record.requirements.length);

    const audience = brief.sections.find((section) => section.id === 'audience');
    expect(audience?.heading).toBe(catalogT('front_desk:hearing_req_audience', undefined, 'en'));
    expect(audience?.answered).toBe(true);
    expect(audience?.body).toBe('Freelancers booking studio time.');

    const problem = brief.sections.find((section) => section.id === 'problem');
    expect(problem?.answered).toBe(false);
    expect(problem?.body).toBe(catalogT('front_desk:hearing_canvas_unanswered', undefined, 'en'));
  });

  it('lists only the unanswered requirement headings under `unanswered`', () => {
    const brief = buildHearingCanvasBrief(fixtureRecord(), 'en');
    const openHeadings = brief.sections
      .filter((section) => !section.answered)
      .map((section) => section.heading);
    expect(brief.unanswered).toEqual(openHeadings);
    expect(brief.unanswered).not.toContain(
      catalogT('front_desk:hearing_req_audience', undefined, 'en')
    );
  });

  it('re-resolves headings per locale without mutating the persisted record', () => {
    const record = fixtureRecord();
    const ja = buildHearingCanvasBrief(record, 'ja');
    expect(ja.title).toBe(catalogT('front_desk:hearing_canvas_heading', undefined, 'ja'));
    expect(ja.sections[0].heading).not.toBe(
      buildHearingCanvasBrief(record, 'en').sections[0].heading
    );
  });
});

describe('buildHearingCanvasPrompt', () => {
  it('states the target language, embeds the design tokens as CSS custom properties, and includes the brief content', () => {
    const record = fixtureRecord();
    const brief = buildHearingCanvasBrief(record, 'ja');
    const tokens = {
      colors: {
        primary: '#123456',
        secondary: '#abcdef',
        accent: '#ff00aa',
        background: '#ffffff',
        text: '#000000',
        warning: '#ff0000',
      },
      fonts: { sans: 'sans', mono: 'mono', heading: 'Heading Font', body: 'Body Font' },
    } as any;

    const prompt = buildHearingCanvasPrompt(brief, tokens);

    expect(prompt).toContain('ja');
    expect(prompt).toContain('<html><head><style>...</style></head><body>...</body></html>');
    expect(prompt).toContain('--color-primary: #123456;');
    expect(prompt).toContain('--color-accent: #ff00aa;');
    expect(prompt).toContain('--font-heading: Heading Font;');
    expect(prompt).toContain(brief.title);
    expect(prompt).toContain(catalogT('front_desk:hearing_req_audience', undefined, 'ja'));
    expect(prompt).not.toContain('<img');
  });
});

describe('sanitizeGeneratedCanvasHtml', () => {
  it('accepts a single clean self-contained html document', () => {
    const result = sanitizeGeneratedCanvasHtml(CLEAN_DOCUMENT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.html).toContain('<h1>Draft</h1>');
    }
  });

  it('rejects empty input', () => {
    expect(sanitizeGeneratedCanvasHtml('')).toEqual({ ok: false, reason: 'empty' });
    expect(sanitizeGeneratedCanvasHtml('   ')).toEqual({ ok: false, reason: 'empty' });
  });

  it('rejects a document over the 200KB cap', () => {
    const oversized =
      '<html><head><style></style></head><body>' + 'x'.repeat(200 * 1024) + '</body></html>';
    expect(sanitizeGeneratedCanvasHtml(oversized)).toEqual({ ok: false, reason: 'too_large' });
  });

  it('rejects content that is not a single <html> document', () => {
    expect(sanitizeGeneratedCanvasHtml('<p>not a document</p>').ok).toBe(false);
    expect(sanitizeGeneratedCanvasHtml(`${CLEAN_DOCUMENT}${CLEAN_DOCUMENT}`)).toEqual({
      ok: false,
      reason: 'not_single_html_document',
    });
    expect(
      sanitizeGeneratedCanvasHtml(`${CLEAN_DOCUMENT}\ntrailing text after the document`)
    ).toEqual({ ok: false, reason: 'not_single_html_document' });
  });

  const rejectionCases: Array<[string, string]> = [
    ['script_tag', '<html><head></head><body><script>alert(1)</script></body></html>'],
    [
      'event_handler_attribute',
      '<html><head></head><body><div onclick="x()">hi</div></body></html>',
    ],
    ['src_attribute', '<html><head></head><body><div src="x.png">hi</div></body></html>'],
    ['href_attribute', '<html><head></head><body><div href="x">hi</div></body></html>'],
    ['http_url', '<html><head></head><body><p>see http://example.com</p></body></html>'],
    ['https_url', '<html><head></head><body><p>see https://example.com</p></body></html>'],
    ['javascript_protocol', '<html><head></head><body><p>javascript:alert(1)</p></body></html>'],
    ['css_import', '<html><head><style>@import "x.css";</style></head><body></body></html>'],
    [
      'css_url_function',
      '<html><head><style>div{background:url(x.png)}</style></head><body></body></html>',
    ],
    ['iframe_tag', '<html><head></head><body><iframe></iframe></body></html>'],
    ['object_tag', '<html><head></head><body><object></object></body></html>'],
    ['embed_tag', '<html><head></head><body><embed></body></html>'],
    ['form_tag', '<html><head></head><body><form></form></body></html>'],
    [
      'meta_http_equiv',
      '<html><head><meta http-equiv="refresh" content="0"></head><body></body></html>',
    ],
  ];

  it.each(rejectionCases)('rejects %s', (reasonSuffix, html) => {
    const result = sanitizeGeneratedCanvasHtml(html);
    expect(result.ok).toBe(false);
    if (result.ok === false) expect(result.reason).toBe(`forbidden_pattern:${reasonSuffix}`);
  });

  it('strips tags outside the allowlist but keeps their text content', () => {
    const html =
      '<html><head></head><body><div><button>Click</button><figure>caption</figure></div></body></html>';
    const result = sanitizeGeneratedCanvasHtml(html);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.html).not.toContain('<button');
      expect(result.html).not.toContain('<figure');
      expect(result.html).toContain('Click');
      expect(result.html).toContain('caption');
    }
  });

  it('escapes a stray ampersand without double-escaping an existing entity', () => {
    const html = '<html><head></head><body><p>Q&A &amp; more</p></body></html>';
    const result = sanitizeGeneratedCanvasHtml(html);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.html).toContain('Q&amp;A &amp; more');
    }
  });
});

describe('generateHearingCanvas', () => {
  it('falls back to the template under the stub backend (not a valid single-html document)', async () => {
    resetReasoningBackend();
    const record = fixtureRecord();
    const result = await generateHearingCanvas(record, { locale: 'en' });
    expect(result.source).toBe('template');
    expect(result.html).toContain('<html');
    expect(result.reason).toBeTruthy();
  });

  it('returns a generated result when the backend produces a clean document', async () => {
    registerReasoningBackend({
      ...stubReasoningBackend,
      name: 'fake-clean',
      delegateTask: vi.fn(async () => CLEAN_DOCUMENT),
    });
    const result = await generateHearingCanvas(fixtureRecord(), { locale: 'en' });
    expect(result.source).toBe('generated');
    expect(result.html).toContain('<h1>Draft</h1>');
  });

  it('falls back to the template when the backend output fails sanitization', async () => {
    registerReasoningBackend({
      ...stubReasoningBackend,
      name: 'fake-dirty',
      delegateTask: vi.fn(
        async () => '<html><head></head><body><script>alert(1)</script></body></html>'
      ),
    });
    const result = await generateHearingCanvas(fixtureRecord(), { locale: 'en' });
    expect(result.source).toBe('template');
    expect(result.reason).toBe('forbidden_pattern:script_tag');
  });

  it('falls back to the template after the timeout when the backend never resolves', async () => {
    vi.useFakeTimers();
    try {
      registerReasoningBackend({
        ...stubReasoningBackend,
        name: 'fake-hanging',
        delegateTask: () => new Promise<string>(() => {}),
      });
      const pending = generateHearingCanvas(fixtureRecord(), { locale: 'en' });
      await vi.advanceTimersByTimeAsync(20_000);
      const result = await pending;
      expect(result.source).toBe('template');
      expect(result.reason).toContain('HEARING_CANVAS_TIMEOUT');
    } finally {
      vi.useRealTimers();
    }
  });
});
