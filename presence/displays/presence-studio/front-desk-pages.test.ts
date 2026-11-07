// UI-05 / UI-06 (SURFACE_UI_UNIFICATION_PLAN_2026-09-23): the front-desk
// pages are small server-rendered templates — `{{t:<key>}}` vocabulary
// placeholders, `{{locale}}`, and a fixed allow-list of shared shell
// partials — so their chrome is in the viewer's language at first paint.
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { t as catalogT, type VocabularyKey } from '@agent/core/t';
import { loadVocabularyCatalog } from '@agent/core/knowledge/vocabulary-catalog';
import { readFrontDeskSurfaceUrls } from '@agent/core/front-desk-nav';
import {
  FRONT_DESK_PAGE_PARTIALS,
  FRONT_DESK_TEMPLATE_FILE_REDIRECTS,
  frontDeskTemplateRedirect,
  registerFrontDeskHomeWorkPages,
  registerFrontDeskAuxPages,
  ASK_VOCABULARY_KEYS,
  PRESENCE_STUDIO_VOCABULARY_KEYS,
  renderFrontDeskPageTemplate,
  resolveFrontDeskPageLocale,
} from './front-desk-pages.js';

const STATIC_DIR = 'presence/displays/presence-studio/static';
const SHELL_PAGES = ['home.html', 'ask.html', 'index.html', 'engine-config.html'];
// The OBS projection has no navigation shell, but is still a localized template.
const PAGES = [...SHELL_PAGES, 'live-avatar.html'];

function readStatic(file: string): string {
  return String(
    safeReadFile(pathResolver.rootResolve(path.join(STATIC_DIR, file)), {
      encoding: 'utf8',
    }) || ''
  );
}

describe('resolveFrontDeskPageLocale', () => {
  it('prefers the shell cookie, then Accept-Language, then English', () => {
    expect(resolveFrontDeskPageLocale({ cookie: 'a=1; kb-ui-locale=ja; b=2' })).toBe('ja');
    expect(
      resolveFrontDeskPageLocale({
        cookie: 'kb-ui-locale=en',
        'accept-language': 'ja-JP',
      })
    ).toBe('en');
    expect(
      resolveFrontDeskPageLocale({
        'accept-language': 'fr-FR,ja;q=0.8,en;q=0.5',
      })
    ).toBe('ja');
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
    for (const page of SHELL_PAGES) {
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
    const sheets = ['design-system.css', 'home.css', 'ask.css', 'work.css'];
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
    const middleware: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
    const app = {
      get: (route: string, handler: Handler) => routes.set(route, handler),
      use: (handler: (req: unknown, res: unknown, next: () => void) => void) =>
        middleware.push(handler),
    };
    registerFrontDeskHomeWorkPages(app as never, pathResolver.rootResolve(STATIC_DIR));
    registerFrontDeskAuxPages(app as never, pathResolver.rootResolve(STATIC_DIR));
    return { routes, middleware };
  }

  /** Runs the guard middleware for a request; returns whether it passed through. */
  function runGuard(
    middleware: Array<(req: unknown, res: unknown, next: () => void) => void>,
    requestPath: string,
    res: unknown
  ): boolean {
    const queryIndex = requestPath.indexOf('?');
    const req = {
      method: 'GET',
      path: queryIndex === -1 ? requestPath : requestPath.slice(0, queryIndex),
      originalUrl: requestPath,
    };
    let passed = false;
    for (const handler of middleware) handler(req, res, () => (passed = true));
    return passed;
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
    // `/help.html`, `/progress.html` and `/first-job.html` stay mapped after
    // their pages moved to Concierge, so an old bookmark still lands there
    // (via the redirects).
    expect(Object.keys(FRONT_DESK_TEMPLATE_FILE_REDIRECTS).sort()).toEqual(
      [...PAGES, 'help.html', 'progress.html', 'first-job.html'].map((page) => `/${page}`).sort()
    );
    expect(frontDeskTemplateRedirect('/first-job.html?x=1')).toBe('/first-job?x=1');
    expect(frontDeskTemplateRedirect('/engine-config.html')).toBe('/engine-config');
    expect(frontDeskTemplateRedirect('/home.html')).toBe('/home');
    expect(frontDeskTemplateRedirect('/progress.html?tenant=acme#x')).toBe(
      '/progress?tenant=acme#x'
    );
    expect(frontDeskTemplateRedirect('/ui-gallery.html')).toBeNull();
  });

  it('hands /first-job to Concierge, keeping the query', () => {
    const { routes } = recordRoutes();
    const concierge = readFrontDeskSurfaceUrls().concierge;
    const res = fakeRes();
    routes.get('/first-job')!({ originalUrl: '/first-job?locale=ja', params: {} }, res);
    expect(res.statusCode).toBe(302);
    expect(res.location).toBe(concierge + '/first-job?locale=ja');
    expect(res.sent).toBeUndefined();
    const bare = fakeRes();
    routes.get('/first-job')!({ originalUrl: '/first-job', params: {} }, bare);
    expect(bare.location).toBe(concierge + '/first-job');
  });

  it('hands /help and /help/<track> to Concierge, keeping the query', () => {
    const { routes } = recordRoutes();
    const concierge = readFrontDeskSurfaceUrls().concierge;
    const top = fakeRes();
    routes.get('/help')!({ originalUrl: '/help?tenant=acme', params: {} }, top);
    expect(top.statusCode).toBe(302);
    expect(top.location).toBe(concierge + '/help?tenant=acme');
    const track = fakeRes();
    routes.get('/help/:track')!(
      { originalUrl: '/help/first%20steps', params: { track: 'first steps' } },
      track
    );
    expect(track.statusCode).toBe(302);
    expect(track.location).toBe(concierge + '/help/first%20steps');
    expect(track.sent).toBeUndefined();
  });

  it('hands /progress to Concierge 仕事 › 依頼, keeping the query in one query string', () => {
    const { routes } = recordRoutes();
    const concierge = readFrontDeskSurfaceUrls().concierge;
    const bare = fakeRes();
    routes.get('/progress')!({ originalUrl: '/progress', params: {} }, bare);
    expect(bare.statusCode).toBe(302);
    expect(bare.location).toBe(concierge + '/work?tab=requests');
    const linked = fakeRes();
    routes.get('/progress')!(
      { originalUrl: '/progress?request=req-1&tenant=acme&tab=missions', params: {} },
      linked
    );
    expect(linked.statusCode).toBe(302);
    expect(linked.location).toBe(concierge + '/work?tab=requests&request=req-1&tenant=acme');
    expect(linked.sent).toBeUndefined();
  });

  it('renders the settings editor in the requested locale with a disabled form and shared navigation', () => {
    const { routes } = recordRoutes();
    for (const locale of ['en', 'ja'] as const) {
      const res = fakeRes();
      routes.get('/engine-config')!({ headers: { 'accept-language': locale } }, res);
      const html = String(res.sent);
      expect(html).toContain('<html lang="' + locale + '"');
      expect(html).toContain(catalogT('presence_studio:engine_config_title', undefined, locale));
      expect(html).not.toMatch(/{{(t|partial|locale)[:}]/);
      expect(html).toMatch(/id="engine-fields"[^>]*disabled/);
      expect(html).toContain('name="agent_runtime_backend"');
      expect(html).toContain('value="pipe"');
      expect(html).toContain('value="pane"');
      expect(html).toContain('aria-live="polite"');
      expect(html).toContain('href="/help"');
    }
  });

  it('renders the live avatar with localized status and no raw placeholders', () => {
    const { routes } = recordRoutes();
    for (const locale of ['en', 'ja'] as const) {
      const res = fakeRes();
      routes.get('/live-avatar')!({ headers: { 'accept-language': locale } }, res);
      const html = String(res.sent);
      expect(html).toContain(`<html lang="${locale}"`);
      expect(html).toContain(catalogT('presence_studio:live_avatar_connecting', undefined, locale));
      expect(html).toContain(catalogT('presence_studio:live_avatar_offline', undefined, locale));
      expect(html).not.toContain('{{');
    }
  });

  it('registers redirects for /<page>.html and 404s for the shell partials, ahead of express.static', () => {
    const { routes, middleware } = recordRoutes();
    for (const [file, target] of Object.entries(FRONT_DESK_TEMPLATE_FILE_REDIRECTS)) {
      const encoded = file.replace('.html', '%2Ehtml');
      for (const variant of [file, encoded, file.toUpperCase()]) {
        const res = fakeRes();
        expect(runGuard(middleware, `${variant}?a=1`, res), variant).toBe(false);
        expect(res.statusCode, variant).toBe(302);
        expect(res.location, variant).toBe(`${target}?a=1`);
      }
    }
    for (const partial of Object.values(FRONT_DESK_PAGE_PARTIALS)) {
      const res = fakeRes();
      expect(runGuard(middleware, `/${partial.replace('.', '%2E')}`, res)).toBe(false);
      expect(res.statusCode, partial).toBe(404);
      expect(String(res.sent)).not.toContain('{{');
    }
    expect(runGuard(middleware, '/ui-gallery.html', fakeRes())).toBe(true);
    // The canonical routes still render the template (no placeholder left).
    // Home's 初めての仕事 entry follows Studio's /first-job redirect to Concierge.
    expect(readStatic('home.html')).toContain('href="/first-job"');
    const home = fakeRes();
    routes.get('/home')!({ headers: { 'accept-language': 'ja' } }, home);
    expect(String(home.sent)).toContain('<html lang="ja"');
    expect(String(home.sent)).not.toMatch(/\{\{(t|partial|locale)[:}]/);
  });
});

it('delivers every required Ask boot label and keeps localized SSR recovery controls', () => {
  const script = readStatic('ask-read-recovery.js');
  const required = script.match(/var REQUIRED_BOOT_LABELS = \[([\s\S]*?)\];/)?.[1];
  expect(required).toBeTruthy();
  const requiredKeys = [...required!.matchAll(/['"]([^'"]+)['"]/g)];
  expect(requiredKeys.length).toBeGreaterThan(0);
  for (const match of requiredKeys) {
    expect(ASK_VOCABULARY_KEYS).toContain(match[1]);
    for (const locale of ['en', 'ja'] as const) {
      const text = catalogT(match[1] as VocabularyKey, undefined, locale);
      expect(text.trim()).not.toBe('');
      expect(text).not.toBe(match[1]);
    }
  }
  const source = readStatic('ask.html');
  expect(source).toContain('<script src="/ask-read-recovery.js"></script>');
  expect(source.indexOf('/ask-read-recovery.js')).toBeLessThan(source.indexOf('/ask.js'));
  expect(source).toMatch(/id="ask-send"\s+disabled/);
  expect(source).toContain('data-label-on="{{t:front_desk:ask_handsfree_on}}"');
  expect(source).toContain('data-label-off="{{t:front_desk:ask_handsfree_off}}"');
  for (const locale of ['en', 'ja'] as const) {
    const html = renderFrontDeskPageTemplate(source, locale, readStatic);
    expect(html).toContain(catalogT('front_desk:ask_startup_failed', undefined, locale));
    expect(html).toContain(catalogT('front_desk:ask_recent_failed', undefined, locale));
  }
});

it('loads draft actions before Ask and bounds multiline context', () => {
  const html = readStatic('ask.html');
  expect(html).toContain('<script src="/ask-next-actions.js"></script>');
  expect(html.indexOf('/ask-next-actions.js')).toBeLessThan(html.indexOf('/ask.js'));
  const css = readStatic('ask.css');
  const group = css.match(/\.ask-turn-next-actions \{([\s\S]*?)\}/)?.[1];
  expect(group).toContain('flex-direction: column');
  expect(group).toContain('min-width: 0');
  expect(group).toContain('max-width: 100%');
  const paragraph = css.match(/\.ask-turn-next-actions p \{([\s\S]*?)\}/)?.[1];
  expect(paragraph).toContain('white-space: pre-wrap');
  expect(paragraph).toContain('overflow-wrap: anywhere');
  const button = css.match(/\.ask-turn-next-actions button \{([\s\S]*?)\}/)?.[1];
  expect(button).toContain('white-space: normal');
  expect(button).toContain('overflow-wrap: anywhere');
});
