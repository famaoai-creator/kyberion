// UI-09: computer-surface page template + shared-ui routes (page.ts).
//
// Never imports `server.ts` routes directly (it listens outside tests only,
// but the page contract is exercised here against a recording app).
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { pathResolver, safeExistsSync, safeReadFile } from '@agent/core';
import { resolveVocabularyEntry } from '@agent/core/vocabulary-catalog';
import {
  COMPUTER_SURFACE_SCRIPT_VOCABULARY_KEYS,
  SHARED_UI_MESSAGES_ROUTE,
  SHARED_UI_MODULE_ROUTE,
  SHARED_UI_MODULE_SOURCES,
  SHARED_UI_VANILLA_ROUTE,
  SHARED_UI_VANILLA_SOURCE,
  buildComputerSurfacePageVocabulary,
  isComputerSurfaceDevMode,
  isComputerSurfaceTemplatePath,
  parseLocaleFile,
  registerComputerSurfacePageRoutes,
  registerComputerSurfaceStaticFiles,
  renderComputerSurfacePage,
  resolveComputerSurfacePageLocale,
  toInlineJson,
} from '../page.js';

const STATIC_DIR = 'presence/displays/computer-surface/static';

function readRepoFile(relativePath: string): string {
  return String(safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' }));
}

const template = readRepoFile(`${STATIC_DIR}/index.html`);

describe('computer-surface page template', () => {
  it('resolves the page locale from the shared cookie, then Accept-Language', () => {
    expect(resolveComputerSurfacePageLocale({ cookie: 'a=1; kb-ui-locale=ja' })).toBe('ja');
    expect(
      resolveComputerSurfacePageLocale({ cookie: 'kb-ui-locale=en', 'accept-language': 'ja' })
    ).toBe('en');
    expect(resolveComputerSurfacePageLocale({ 'accept-language': 'fr, ja;q=0.8' })).toBe('ja');
    expect(resolveComputerSurfacePageLocale({ cookie: 'kb-ui-locale=xx' })).toBe('en');
    expect(resolveComputerSurfacePageLocale({})).toBe('en');
  });

  it('turns the developer sandbox on only for exactly ?dev=1', () => {
    expect(isComputerSurfaceDevMode({ dev: '1' })).toBe(true);
    for (const query of [{}, { dev: 'true' }, { dev: ['1', '1'] }, { dev: '0' }, null]) {
      expect(isComputerSurfaceDevMode(query), JSON.stringify(query)).toBe(false);
    }
  });

  it('fills every placeholder and keys only catalog entries (en + ja)', () => {
    const keys = [...template.matchAll(/\{\{t:([a-z0-9_]+:[a-z0-9_]+)\}\}/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(40);
    for (const key of [...new Set([...keys, ...COMPUTER_SURFACE_SCRIPT_VOCABULARY_KEYS])]) {
      const entry = resolveVocabularyEntry(key)?.entry;
      expect(entry?.en, key).toBeTruthy();
      expect(entry?.ja, key).toBeTruthy();
    }
    for (const locale of ['en', 'ja'] as const) {
      const html = renderComputerSurfacePage(template, locale);
      expect(html).not.toMatch(/\{\{[^}]*\}\}/);
      expect(html).toContain(`<html lang="${locale}"`);
    }
    expect(renderComputerSurfacePage(template, 'ja')).toContain('手元ミラー');
    expect(renderComputerSurfacePage(template, 'en')).toContain('Held actions &amp; observations');
  });

  it('keeps the dispatch sandbox out of the page unless the developer flag is set', () => {
    const normal = renderComputerSurfacePage(template, 'en');
    expect(normal).not.toContain('id="dev-a2ui-payload"');
    expect(normal).not.toContain('dev-sandbox:begin');
    expect(normal).toContain('data-dev="false"');
    const dev = renderComputerSurfacePage(template, 'en', { dev: true });
    expect(dev).toContain('id="dev-a2ui-payload"');
    expect(dev).toContain('class="kb-disclosure"');
    expect(dev).toContain('data-dev="true"');
  });

  it('uses only the shared theme: no inline styles, raw colors, glass or gradients', () => {
    expect(template).not.toMatch(/<style|style="/);
    expect(template).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\s*\(|gradient|backdrop-filter/i);
    const css = readRepoFile(`${STATIC_DIR}/computer-surface.css`);
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\s*\(|gradient|backdrop-filter|blur\(/i);
    for (const sheet of ['/design-tokens.css', '/kyberion-ui.css', '/computer-surface.css']) {
      expect(template).toContain(`href="${sheet}"`);
    }
    expect(template).toContain('<script src="/display-prefs.js"></script>');
    expect(template).toContain("from '/shared-ui/kyberion-ui.js'");
    expect(template).toContain('data-density="compact"');
  });

  it('embeds the page vocabulary as script-safe JSON', () => {
    expect(toInlineJson({ a: '</script><b>&' })).not.toMatch(/[<>&]/);
    const vocabulary = buildComputerSurfacePageVocabulary('ja');
    expect(vocabulary.locale).toBe('ja');
    expect(vocabulary.texts['computer_surface:updated_at']).toContain('{time}');
    expect(vocabulary.messages['ui:skeleton_loading']).toBe('読み込み中');
    const html = renderComputerSurfacePage(template, 'ja');
    const json = /<script type="application\/json" id="cs-vocabulary">([\s\S]*?)<\/script>/.exec(
      html
    );
    expect(JSON.parse(json![1]).texts['computer_surface:conn_live']).toBe('ライブ');
  });
});

describe('computer-surface page routes', () => {
  function recordRoutes() {
    const routes = new Map<string, (req: unknown, res: unknown) => void>();
    const app = {
      get(route: string, handler: (req: unknown, res: unknown) => void) {
        routes.set(route, handler);
      },
    };
    registerComputerSurfacePageRoutes(app as never, pathResolver.rootResolve(STATIC_DIR));
    return routes;
  }

  function fakeResponse() {
    const res = {
      statusCode: 200,
      sent: '' as unknown,
      contentType: '',
      body: undefined as unknown,
      headers: {} as Record<string, string>,
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      json(body: unknown) {
        res.body = body;
        return res;
      },
      send(body: unknown) {
        res.sent = body;
        return res;
      },
      sendFile(file: string) {
        res.sent = file;
      },
      type(value: string) {
        res.contentType = value;
        return res;
      },
      setHeader(name: string, value: string) {
        res.headers[name] = value;
      },
    };
    return res;
  }

  it('registers exactly the page and fixed shared-ui routes', () => {
    expect([...recordRoutes().keys()].sort()).toEqual(
      [
        '/',
        '/index.html',
        SHARED_UI_MESSAGES_ROUTE,
        SHARED_UI_MODULE_ROUTE,
        SHARED_UI_VANILLA_ROUTE,
      ].sort()
    );
  });

  it('serves the filled page for the viewer locale, sandbox only with ?dev=1', () => {
    const routes = recordRoutes();
    const page = fakeResponse();
    routes.get('/')!({ headers: { cookie: 'kb-ui-locale=ja' }, query: {} }, page);
    expect(page.contentType).toBe('html');
    expect(page.headers['Content-Language']).toBe('ja');
    expect(page.headers['Cache-Control']).toBe('no-store');
    expect(String(page.sent)).toContain('lang="ja"');
    expect(String(page.sent)).not.toContain('id="dev-a2ui-payload"');
    const dev = fakeResponse();
    routes.get('/index.html')!({ headers: {}, query: { dev: '1' } }, dev);
    expect(String(dev.sent)).toContain('dev-a2ui-payload');
  });

  it('serves the renderer and only allow-listed sibling modules', () => {
    const routes = recordRoutes();
    const script = fakeResponse();
    routes.get(SHARED_UI_VANILLA_ROUTE)!({}, script);
    expect(script.sent).toBe(pathResolver.rootResolve(SHARED_UI_VANILLA_SOURCE));
    expect(script.contentType).toMatch(/^text\/javascript/);
    expect(script.headers['X-Content-Type-Options']).toBe('nosniff');
    for (const [file, source] of Object.entries(SHARED_UI_MODULE_SOURCES)) {
      const res = fakeResponse();
      routes.get(SHARED_UI_MODULE_ROUTE)!({ params: { file } }, res);
      expect(res.sent).toBe(pathResolver.rootResolve(source));
      expect(safeExistsSync(pathResolver.rootResolve(source))).toBe(true);
    }
    // Exactly the renderer's transitive sibling imports: every module loads, nothing else is reachable.
    const seen = new Set<string>();
    const queue = [SHARED_UI_VANILLA_SOURCE];
    while (queue.length) {
      for (const [, file] of readRepoFile(queue.shift()!).matchAll(/from '\.\/([\w-]+\.js)'/g)) {
        if (seen.has(file)) continue;
        seen.add(file);
        queue.push(`libs/shared-ui/vanilla/${file}`);
      }
    }
    expect([...seen].sort()).toEqual(Object.keys(SHARED_UI_MODULE_SOURCES).sort());
    for (const file of ['../x.js', 'kyberion-ui.test.ts', 'index.html', '']) {
      const res = fakeResponse();
      routes.get(SHARED_UI_MODULE_ROUTE)!({ params: { file } }, res);
      expect(res.statusCode, file).toBe(404);
    }
  });

  it('serves the ui message bundle for supported locales only', () => {
    expect(parseLocaleFile('ja.json')).toBe('ja');
    expect(parseLocaleFile('../ja.json')).toBeNull();
    const routes = recordRoutes();
    const ok = fakeResponse();
    routes.get(SHARED_UI_MESSAGES_ROUTE)!({ params: { file: 'en.json' } }, ok);
    expect((ok.body as { ok: boolean; locale: string }).locale).toBe('en');
    const missing = fakeResponse();
    routes.get(SHARED_UI_MESSAGES_ROUTE)!({ params: { file: 'xx.json' } }, missing);
    expect(missing.statusCode).toBe(404);
  });
});

describe('computer-surface static files never leak the raw template', () => {
  it('recognises every spelling of the template path', () => {
    for (const p of [
      '/index.html',
      '/index%2Ehtml',
      '/index%2ehtml',
      '/INDEX.html',
      '/Index.HTML.',
      '/a/index.html',
    ]) {
      expect(isComputerSurfaceTemplatePath(p), p).toBe(true);
    }
    for (const p of ['/', '/kyberion-ui.css', '/index.htm', '/index%252Ehtml', '/%E0%A4%A']) {
      expect(isComputerSurfaceTemplatePath(p), p).toBe(false);
    }
  });

  it('answers encoded / re-cased template paths with the filled page or 404, never the template', async () => {
    const app = express();
    const staticDir = pathResolver.rootResolve(STATIC_DIR);
    registerComputerSurfacePageRoutes(app, staticDir);
    registerComputerSurfaceStaticFiles(app, staticDir);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as AddressInfo;
    try {
      for (const target of ['/index%2Ehtml', '/index%2ehtml', '/INDEX.html', '/INDEX%2EHTML']) {
        const res = await fetch(`http://127.0.0.1:${port}${target}`);
        const body = await res.text();
        expect(body, target).not.toContain('dev-sandbox:begin');
        expect(body, target).not.toContain('id="dev-a2ui-payload"');
        expect(body, target).not.toMatch(/\{\{[^}]*\}\}/);
        expect([200, 404], target).toContain(res.status);
      }
      expect((await fetch(`http://127.0.0.1:${port}/index%2Ehtml`)).status).toBe(404);
      // Real static assets are still served.
      expect((await fetch(`http://127.0.0.1:${port}/kyberion-ui.css`)).status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
