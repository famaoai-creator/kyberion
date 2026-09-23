import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeReadFile } from '@agent/core/secure-io';
import {
  buildPadBootstrap,
  handlePadUiAsset,
  inlinePadStylesheets,
  PAD_THEME_PREPAINT_SCRIPT,
  PAD_UI_CLIENT_SCRIPT,
  PAD_UI_STYLESHEET,
  PAD_UI_TOKENS_CSS,
  padT,
  renderPadHeader,
  renderPadPage,
  resolvePadLocale,
  resolveSharedUiModule,
  toPadInlineJson,
} from './pad-ui.js';
import { KB_UI_STYLESHEET_PATHS, PAD_UI_TOKENS_CSS_PATH } from '../generate_design_tokens.js';

interface Captured {
  status?: number;
  headers: Record<string, string>;
  body: string;
}

function fakeResponse(): { res: ServerResponse; out: Captured } {
  const out: Captured = { headers: {}, body: '' };
  const res = {
    headersSent: false,
    writeHead(status: number, headers: Record<string, string> = {}) {
      out.status = status;
      out.headers = { ...headers };
      this.headersSent = true;
      return this;
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) out.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
      return this;
    },
  };
  return { res: res as unknown as ServerResponse, out };
}

function get(url: string, method = 'GET') {
  const { res, out } = fakeResponse();
  const handled = handlePadUiAsset({ method, url, headers: {} }, res);
  return { handled, ...out };
}

const fixed = () => 'en' as const;

describe('pad-ui asset serving', () => {
  it('serves the renderer and any vanilla module with a JS content type', () => {
    for (const url of [
      '/shared-ui/kyberion-ui.js',
      '/shared-ui/charts.js',
      '/shared-ui/kyberion-ui.js?v=1',
    ]) {
      const result = get(url);
      expect(result.handled).toBe(true);
      expect(result.status).toBe(200);
      expect(result.headers['Content-Type']).toBe('text/javascript; charset=utf-8');
      expect(result.headers['X-Content-Type-Options']).toBe('nosniff');
      expect(result.headers['Cache-Control']).toBe('no-store');
      expect(result.body).toContain('export');
    }
  });

  it.each([
    '/shared-ui/../x.js',
    '/shared-ui/..%2Fcore%2Findex.js',
    '/shared-ui/%2e%2e/x.js',
    '/shared-ui/%2e%2e%2fkyberion-ui.js',
    '/shared-ui/sub%2Fkyberion-ui.js',
    '/shared-ui/sub/kyberion-ui.js',
    '/shared-ui/Kyberion-UI.js',
    '/shared-ui/kyberion-ui.test.js',
    '/shared-ui/voice.d.ts',
    '/shared-ui/kyberion-ui.test.ts',
    '/shared-ui/fake-dom.test-support.ts',
    '/shared-ui/missing-module.js',
    '/shared-ui/kyberion-ui%2ejs',
    '/shared-ui/',
    '/pad-ui/../pad-ui.ts',
    '/pad-ui/other.js',
  ])('rejects %s with 404', (url) => {
    const result = get(url);
    expect(result.handled).toBe(true);
    expect(result.status).toBe(404);
  });

  it('resolves module names only to regular files directly in the vanilla directory', () => {
    expect(resolveSharedUiModule('/shared-ui/forms.js')).toBe('libs/shared-ui/vanilla/forms.js');
    expect(resolveSharedUiModule('/shared-ui/..%2fforms.js')).toBeNull();
    expect(resolveSharedUiModule('/other/forms.js')).toBeNull();
  });

  it('serves the ui message bundle for supported locales only', () => {
    const ja = get('/shared-ui/messages/ja.json');
    expect(ja.status).toBe(200);
    expect(ja.headers['Content-Type']).toBe('application/json; charset=utf-8');
    const payload = JSON.parse(ja.body);
    expect(payload).toMatchObject({ ok: true, locale: 'ja' });
    expect(Object.keys(payload.messages).length).toBeGreaterThan(0);
    expect(get('/shared-ui/messages/qps-ploc.json').status).toBe(200);
    for (const url of [
      '/shared-ui/messages/fr.json',
      '/shared-ui/messages/../ja.json',
      '/shared-ui/messages/JA.json',
    ]) {
      expect(get(url).status).toBe(404);
    }
  });

  it('serves the generated stylesheets and the client module', () => {
    const tokens = get('/design-tokens.css');
    expect(tokens.status).toBe(200);
    expect(tokens.headers['Content-Type']).toBe('text/css; charset=utf-8');
    expect(tokens.body).toContain('--kb-ui-');
    const sheet = get('/kyberion-ui.css');
    expect(sheet.headers['Content-Type']).toBe('text/css; charset=utf-8');
    expect(sheet.body).toContain('.kb-app-shell');
    const client = get('/pad-ui/pad-client.js');
    expect(client.headers['Content-Type']).toBe('text/javascript; charset=utf-8');
    expect(client.body).toContain('export function bootPad');
  });

  it('answers only GET and leaves other paths to the pad', () => {
    const post = get('/kyberion-ui.css', 'POST');
    expect(post).toMatchObject({ handled: true, status: 405 });
    expect(post.headers.Allow).toBe('GET');
    expect(get('/').handled).toBe(false);
    expect(get('/export', 'POST').handled).toBe(false);
    expect(get('/shared-ui-other.js').handled).toBe(false);
  });

  it('keeps every generated file on disk and registered with the token generator', () => {
    for (const file of [PAD_UI_TOKENS_CSS, PAD_UI_STYLESHEET, PAD_UI_CLIENT_SCRIPT]) {
      expect(safeExistsSync(pathResolver.rootResolve(file)), file).toBe(true);
    }
    expect(PAD_UI_TOKENS_CSS_PATH).toBe(pathResolver.rootResolve(PAD_UI_TOKENS_CSS));
    expect(KB_UI_STYLESHEET_PATHS).toContain(pathResolver.rootResolve(PAD_UI_STYLESHEET));
    const tokens = String(
      safeReadFile(pathResolver.rootResolve(PAD_UI_TOKENS_CSS), { encoding: 'utf8' })
    );
    // Only the --kb-ui-* layer (like concierge), never the legacy --kb-* block.
    expect(tokens).toMatch(/--kb-ui-/);
    expect(tokens).not.toMatch(/--kb-(?!ui-)[a-z]/);
  });
});

describe('pad-ui locale', () => {
  const req = (url: string, headers: Record<string, string> = {}) => ({ url, headers });

  it('prefers ?lang= over cookie, Accept-Language and the default', () => {
    expect(
      resolvePadLocale(
        req('/?lang=ja', { cookie: 'kb-ui-locale=en', 'accept-language': 'en' }),
        fixed
      )
    ).toBe('ja');
    expect(resolvePadLocale(req('/?lang=qps-ploc'), fixed)).toBe('qps-ploc');
  });

  it('uses the kb-ui-locale cookie next', () => {
    expect(
      resolvePadLocale(
        req('/', { cookie: 'a=1; kb-ui-locale=ja; b=2', 'accept-language': 'en' }),
        fixed
      )
    ).toBe('ja');
    // an unsupported / pseudo cookie value says nothing
    expect(
      resolvePadLocale(
        req('/', { cookie: 'kb-ui-locale=qps-ploc', 'accept-language': 'ja' }),
        fixed
      )
    ).toBe('ja');
    expect(resolvePadLocale(req('/?lang=xx', { cookie: 'kb-ui-locale=fr' }), fixed)).toBe('en');
  });

  it('then the highest-weighted supported Accept-Language tag', () => {
    expect(
      resolvePadLocale(req('/', { 'accept-language': 'fr-FR, ja-JP;q=0.8, en;q=0.9' }), fixed)
    ).toBe('en');
    expect(resolvePadLocale(req('/', { 'accept-language': 'fr, ja-JP;q=0.5' }), () => 'en')).toBe(
      'ja'
    );
    expect(resolvePadLocale(req('/', { 'accept-language': 'ja;q=0, *' }), () => 'en')).toBe('en');
  });

  it('falls back to the resolver default', () => {
    expect(resolvePadLocale(req('/'), () => 'ja')).toBe('ja');
    expect(['en', 'ja', 'qps-ploc']).toContain(resolvePadLocale(req('/')));
  });

  it('translates with an explicit locale regardless of the process default', () => {
    expect(padT('ja')('local_pads:badge')).toBe('ローカルパッド');
    expect(padT('en')('local_pads:badge')).toBe('Local pad');
    expect(padT('en')('local_pads:page_title', { title: 'Sketch' })).toBe('Sketch — Kyberion');
  });
});

describe('pad-ui page shell', () => {
  it('renders a full document for the locale with the shared stylesheets', () => {
    const html = renderPadPage({
      locale: 'ja',
      title: 'Sketch',
      bodyHtml: '<p id="x">body</p>',
      role: 'sketch-input',
    });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="ja">');
    expect(html).toContain('<title>Sketch — Kyberion</title>');
    expect(html).toContain('<link rel="stylesheet" href="/design-tokens.css" />');
    expect(html).toContain('<link rel="stylesheet" href="/kyberion-ui.css" />');
    expect(html).toContain(
      'class="kb-app-shell" data-density="comfortable" data-role="sketch-input"'
    );
    expect(html).toContain('<main class="kb-app-shell__main">');
    expect(html).toContain('<p id="x">body</p>');
    expect(html).toContain('JavaScript');
  });

  it('applies the saved theme before the stylesheets load', () => {
    const html = renderPadPage({ locale: 'en', title: 'T', bodyHtml: '' });
    expect(PAD_THEME_PREPAINT_SCRIPT).toContain('"kyberion.ui.theme"');
    expect(PAD_THEME_PREPAINT_SCRIPT).toContain('try{');
    expect(PAD_THEME_PREPAINT_SCRIPT).toContain("removeAttribute('data-theme')");
    const prepaint = html.indexOf(PAD_THEME_PREPAINT_SCRIPT);
    expect(prepaint).toBeGreaterThan(0);
    expect(prepaint).toBeLessThan(html.indexOf('/design-tokens.css'));
  });

  it('embeds the bootstrap JSON injection-safely', () => {
    const hostile = '</script><script>alert(1)</script><!-- \u2028';
    const html = renderPadPage({
      locale: 'en',
      title: '<b>t</b>',
      bodyHtml: '',
      bootstrap: { note: hostile, locale: 'xx' },
      textKeys: ['local_pads:page_title'],
    });
    const match = /<script type="application\/json" id="pad-bootstrap">([\s\S]*?)<\/script>/.exec(
      html
    );
    expect(match).not.toBeNull();
    expect(match![1]).not.toMatch(/<\/?script|<\!--/i);
    const parsed = JSON.parse(match![1]);
    expect(parsed.note).toBe(hostile);
    expect(parsed.locale).toBe('en');
    expect(Object.keys(parsed.messages).length).toBeGreaterThan(0);
    expect(parsed.texts).toMatchObject({
      'local_pads:badge': 'Local pad',
      'local_pads:page_title': '{title} — Kyberion',
    });
    expect(html).toContain('<title>&lt;b&gt;t&lt;/b&gt; — Kyberion</title>');
    expect(toPadInlineJson('</script>')).toBe('"\\u003c/script\\u003e"');
  });

  it('keeps an inline module from closing its script element', () => {
    const html = renderPadPage({
      locale: 'en',
      title: 'T',
      bodyHtml: '',
      scriptModule:
        "import { bootPad } from '/pad-ui/pad-client.js';\nconst s = '</script>';\nbootPad();",
    });
    expect(html).toContain('<script type="module">');
    expect(html).toContain("const s = '<\\/script>';");
    expect(html.match(/<\/script>/g)).toHaveLength(3); // prepaint, bootstrap, module
  });

  it('builds the header with a display-controls slot and escaped text', () => {
    const header = renderPadHeader({
      locale: 'ja',
      title: 'A&B',
      subtitle: '<i>s</i>',
      actionsHtml: '<button>x</button>',
    });
    expect(header).toContain('A&amp;B');
    expect(header).toContain('&lt;i&gt;s&lt;/i&gt;');
    expect(header).toContain('ローカルパッド');
    expect(header).toContain('<button>x</button><div data-pad-display-controls></div>');
  });

  it('bootstrap reserved keys win over pad data', () => {
    const bootstrap = buildPadBootstrap({ locale: 'ja', bootstrap: { texts: 'x', token: 't' } });
    expect(bootstrap.locale).toBe('ja');
    expect(bootstrap.token).toBe('t');
    expect(typeof bootstrap.texts).toBe('object');
  });

  it('inlines tokens and components for offline documents', () => {
    const css = inlinePadStylesheets();
    expect(css).toContain('--kb-ui-');
    expect(css).toContain('.kb-app-shell');
    expect(css).not.toMatch(/<\/style/i);
    expect(css.indexOf('--kb-ui-')).toBeLessThan(css.indexOf('.kb-app-shell'));
  });
});
