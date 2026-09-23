// UI-05 / UI-06 (SURFACE_UI_UNIFICATION_PLAN_2026-09-23): the front-desk
// pages are small server-rendered templates — `{{t:<key>}}` vocabulary
// placeholders, `{{locale}}`, and a fixed allow-list of shared shell
// partials — so their chrome is in the viewer's language at first paint.
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { t as catalogT, type VocabularyKey } from '@agent/core/t';
import {
  FRONT_DESK_PAGE_PARTIALS,
  FRONT_DESK_TEMPLATE_FILE_REDIRECTS,
  frontDeskTemplateRedirect,
  registerFrontDeskHomeWorkPages,
  renderFrontDeskPageTemplate,
  resolveFrontDeskPageLocale,
} from './front-desk-pages.js';

const STATIC_DIR = 'presence/displays/presence-studio/static';
const PAGES = ['home.html', 'ask.html', 'progress.html', 'help.html', 'index.html'];

function readStatic(file: string): string {
  return String(
    safeReadFile(pathResolver.rootResolve(path.join(STATIC_DIR, file)), { encoding: 'utf8' }) || ''
  );
}

describe('resolveFrontDeskPageLocale', () => {
  it('prefers the shell cookie, then Accept-Language, then English', () => {
    expect(resolveFrontDeskPageLocale({ cookie: 'a=1; kb-ui-locale=ja; b=2' })).toBe('ja');
    expect(
      resolveFrontDeskPageLocale({ cookie: 'kb-ui-locale=en', 'accept-language': 'ja-JP' })
    ).toBe('en');
    expect(resolveFrontDeskPageLocale({ 'accept-language': 'fr-FR,ja;q=0.8,en;q=0.5' })).toBe('ja');
    expect(resolveFrontDeskPageLocale({ 'accept-language': 'en-US,en;q=0.9' })).toBe('en');
    expect(resolveFrontDeskPageLocale({ cookie: 'kb-ui-locale=de' })).toBe('en');
    expect(resolveFrontDeskPageLocale({})).toBe('en');
  });
});

describe('renderFrontDeskPageTemplate', () => {
  it('fills vocabulary placeholders (escaped), the locale and allow-listed partials only', () => {
    const partials: Record<string, string> = {
      'front-desk-rail.partial.html': '<nav>{{t:front_desk:nav_home}}</nav>',
    };
    const html = renderFrontDeskPageTemplate(
      '<html lang="{{locale}}">{{partial:rail}}{{partial:unknown}}<h1>{{t:front_desk:nav_home}}</h1>',
      'ja',
      (file) => partials[file] ?? ''
    );
    const home = catalogT('front_desk:nav_home', undefined, 'ja');
    expect(html).toBe(`<html lang="ja"><nav>${home}</nav><h1>${home}</h1>`);
    expect(Object.keys(FRONT_DESK_PAGE_PARTIALS).sort()).toEqual(['rail', 'shell-controls']);
  });

  it('renders every front-desk page with no placeholder left and every key known in en and ja', () => {
    const load = (file: string) => readStatic(file);
    for (const page of PAGES) {
      const source = readStatic(page);
      for (const locale of ['en', 'ja'] as const) {
        const html = renderFrontDeskPageTemplate(source, locale, load);
        expect(html, `${page} (${locale})`).not.toMatch(/\{\{(t|partial|locale)[:}]/);
        expect(html, page).toContain(`<html lang="${locale}"`);
      }
    }
    const keys = new Set<string>();
    for (const file of [...PAGES, ...Object.values(FRONT_DESK_PAGE_PARTIALS)]) {
      for (const match of readStatic(file).matchAll(/\{\{t:([a-z0-9_]+:[a-z0-9_]+)\}\}/g)) {
        keys.add(match[1]);
      }
    }
    expect(keys.size).toBeGreaterThan(20);
    for (const key of keys) {
      for (const locale of ['en', 'ja'] as const) {
        expect(catalogT(key as VocabularyKey, undefined, locale), `${key} (${locale})`).not.toBe(
          key
        );
      }
    }
  });

  it('mounts every page on the shared shell: prefs before paint, tokens, rail, header controls', () => {
    for (const page of PAGES) {
      const source = readStatic(page);
      expect(source.indexOf('/front-desk-prefs.js'), page).toBeGreaterThan(-1);
      expect(source.indexOf('/front-desk-prefs.js'), page).toBeLessThan(
        source.indexOf('design-tokens.css')
      );
      expect(source, page).toContain('/kyberion-ui.css');
      expect(source, page).toContain('{{partial:rail}}');
      expect(source, page).toContain('{{partial:shell-controls}}');
      expect(source, page).toContain('data-role="presence-studio"');
      expect(source, page).toContain('<script type="module" src="/front-desk-rail.js"></script>');
      expect(source, page).not.toContain('/api/design-tokens.css');
    }
  });

  it('keeps presence-studio stylesheets on --kb-ui-* tokens (no raw hex / rgb colors, no teal)', () => {
    const sheets = [
      'design-system.css',
      'home.css',
      'ask.css',
      'progress.css',
      'help.css',
      'work.css',
    ];
    for (const sheet of sheets) {
      const css = readStatic(sheet);
      expect(css, sheet).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(css, sheet).not.toMatch(/\brgba?\(/i);
      expect(css, sheet).not.toMatch(/teal|gradient|backdrop-filter/i);
    }
    expect(readStatic('index.html')).not.toContain('<style');
  });

  it('shares the theme / language storage keys with the concierge shell', () => {
    const prefs = readStatic('front-desk-prefs.js');
    // presence/displays/concierge/src/lib/concierge-theme.ts
    expect(prefs).toContain("THEME_KEY = 'kyberion.ui.theme'");
    expect(prefs).toContain("LOCALE_KEY = 'kyberion.ui.locale'");
    expect(prefs).toContain("LOCALE_COOKIE = 'kb-ui-locale'");
    expect(prefs).toContain('try {');
  });
});

describe('raw template files are never served unrendered', () => {
  type Handler = (req: Record<string, unknown>, res: Record<string, unknown>) => void;

  function recordRoutes() {
    const routes = new Map<string, Handler>();
    const app = { get: (route: string, handler: Handler) => routes.set(route, handler) };
    registerFrontDeskHomeWorkPages(app as never, pathResolver.rootResolve(STATIC_DIR));
    return routes;
  }

  function fakeRes() {
    const res: Record<string, unknown> & {
      sent?: unknown;
      statusCode?: number;
      location?: string;
    } = {};
    res.redirect = (status: number, location: string) => {
      res.statusCode = status;
      res.location = location;
      return res;
    };
    res.status = (status: number) => {
      res.statusCode = status;
      return res;
    };
    res.type = () => res;
    res.setHeader = () => res;
    res.send = (body: unknown) => {
      res.sent = body;
      return res;
    };
    return res;
  }

  it('covers every page template and maps it to its canonical route', () => {
    expect(Object.keys(FRONT_DESK_TEMPLATE_FILE_REDIRECTS).sort()).toEqual(
      PAGES.map((page) => `/${page}`).sort()
    );
    expect(frontDeskTemplateRedirect('/home.html')).toBe('/');
    expect(frontDeskTemplateRedirect('/progress.html?tenant=acme#x')).toBe(
      '/progress?tenant=acme#x'
    );
    expect(frontDeskTemplateRedirect('/ui-gallery.html')).toBeNull();
  });

  it('registers redirects for /<page>.html and 404s for the shell partials, ahead of express.static', () => {
    const routes = recordRoutes();
    for (const [file, target] of Object.entries(FRONT_DESK_TEMPLATE_FILE_REDIRECTS)) {
      const res = fakeRes();
      routes.get(file)!({ originalUrl: `${file}?a=1` }, res);
      expect(res.statusCode, file).toBe(302);
      expect(res.location, file).toBe(`${target}?a=1`);
    }
    for (const partial of Object.values(FRONT_DESK_PAGE_PARTIALS)) {
      const res = fakeRes();
      routes.get(`/${partial}`)!({}, res);
      expect(res.statusCode, partial).toBe(404);
      expect(String(res.sent)).not.toContain('{{');
    }
    // The canonical routes still render the template (no placeholder left).
    const home = fakeRes();
    routes.get('/')!({ headers: { 'accept-language': 'ja' } }, home);
    expect(String(home.sent)).toContain('<html lang="ja"');
    expect(String(home.sent)).not.toMatch(/\{\{(t|partial|locale)[:}]/);
  });
});
