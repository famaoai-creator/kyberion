import { describe, expect, it } from 'vitest';
import {
  decodePluginViewFrameHtml,
  findPluginViewFrameViolation,
  isPluginViewFrameDocumentPath,
  PLUGIN_VIEW_FRAME_MAX_BYTES,
  pluginViewFrameResponseHeaders,
  pluginViewMaySendActions,
} from './plugin-view-frame.js';

describe('plugin view frame documents (PH-02)', () => {
  it('accepts only views/*.html document paths', () => {
    expect(isPluginViewFrameDocumentPath('views/status.html')).toBe(true);
    for (const rejected of [
      'views/status.a2ui.json',
      'views/../index.html',
      'views/sub/status.html',
      'status.html',
      'views/Status.html',
      'views/status.html.js',
    ]) {
      expect(isPluginViewFrameDocumentPath(rejected)).toBe(false);
    }
  });

  it.each([
    ['<base href="/">'],
    ['<BASE target=_top>'],
    ['<base/>'],
    ['<meta http-equiv="refresh" content="0;url=/x">'],
    ['<img src="http://evil.example/x.png">'],
    ['<img SRC=https://evil.example/x.png>'],
    ["<script src='//evil.example/x.js'></script>"],
    ['<script src="\\\\evil.example\\x.js"></script>'],
    ['<a href=" \t h\ntt\tps://evil.example">x</a>'],
    ['<a href="&#104;ttps://evil.example">x</a>'],
    ['<a href="https&colon;//evil.example">x</a>'],
    ['<a href="&#x68;&#x74;&#x74;&#x70;&#x3a;//evil.example">x</a>'],
    ['<img srcset="a.png 1x, https://evil.example/b.png 2x">'],
    ['<form action="https://evil.example/collect"></form>'],
    ['<video poster = "http://evil.example/p.png"></video>'],
    ['<object data="https://evil.example/x"></object>'],
    ['<svg><use xlink:href="https://evil.example/s.svg#a"/></svg>'],
    ['<p>\u0000</p>'],
  ])('rejects %j', (html) => {
    expect(findPluginViewFrameViolation(html)).toBeTruthy();
  });

  it.each([
    ['<p>Hello</p><script>const a = 1; if (a <= 2) document.body.dataset.x = "y";</script>'],
    ['<img src="data:image/png;base64,AAAA">'],
    ['<a href="#section">jump</a>'],
    ['<img src="icon.png" srcset="a.png 1x, b.png 2x">'],
    ['<p>visit https://example.com in your browser</p>'],
    ['<baseline-chart></baseline-chart>'],
    ['<script>el.src = "https://x.example";</script>'],
    ['<p>Unicode ✓ text</p>'],
  ])('accepts %j', (html) => {
    expect(findPluginViewFrameViolation(html)).toBeUndefined();
  });

  it('measures the limit in UTF-8 bytes and decodes strictly', () => {
    const multibyte = 'é'.repeat(PLUGIN_VIEW_FRAME_MAX_BYTES / 2);
    expect(findPluginViewFrameViolation(multibyte)).toBeUndefined();
    expect(findPluginViewFrameViolation(`${multibyte}x`)).toMatch(/exceeds/u);
    expect(decodePluginViewFrameHtml(new TextEncoder().encode('<p>ok</p>'))).toBe('<p>ok</p>');
    expect(() => decodePluginViewFrameHtml(new Uint8Array([0x3c, 0xc3, 0x28]))).toThrow(
      'not valid UTF-8'
    );
    expect(() =>
      decodePluginViewFrameHtml(new Uint8Array(PLUGIN_VIEW_FRAME_MAX_BYTES + 1))
    ).toThrow(/exceeds/u);
  });

  it('stays linear on hostile input', () => {
    const hostile = [
      ' srcset=/'.repeat(50_000),
      ' src="'.repeat(80_000),
      '<'.repeat(400_000),
      `${'&'.repeat(200_000)} href=${'&#'.repeat(100_000)}`,
    ];
    const started = performance.now();
    for (const html of hostile) findPluginViewFrameViolation(html);
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it('serves the document with a sandbox CSP and no ambient permissions', () => {
    const headers = pluginViewFrameResponseHeaders();
    const csp = headers['Content-Security-Policy'];
    expect(csp.startsWith('sandbox allow-scripts;')).toBe(true);
    expect(csp).not.toContain('allow-same-origin');
    for (const directive of [
      "default-src 'none'",
      "connect-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      "frame-ancestors 'self'",
    ]) {
      expect(csp).toContain(directive);
    }
    expect(headers).toMatchObject({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    expect(headers['Permissions-Policy']).toContain('camera=()');
    expect(headers['Permissions-Policy']).toContain('microphone=()');
  });

  it('requires action.request and at least one declared action to send actions', () => {
    expect(pluginViewMaySendActions({ capabilities: ['action.request'], actions: [{}] })).toBe(
      true
    );
    expect(pluginViewMaySendActions({ capabilities: [], actions: [{}] })).toBe(false);
    expect(pluginViewMaySendActions({ capabilities: ['action.request'], actions: [] })).toBe(false);
  });
});
