// UI-05 / UI-06 (SURFACE_UI_UNIFICATION_PLAN_2026-09-23): the front-desk
// pages are small server-rendered templates — `{{t:<key>}}` vocabulary
// placeholders, `{{locale}}`, and a fixed allow-list of shared shell
// partials — so their chrome is in the viewer's language at first paint.
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { t as catalogT, type VocabularyKey } from '@agent/core/t';
import { loadVocabularyCatalog } from '@agent/core/knowledge/vocabulary-catalog';
import {
  FRONT_DESK_PAGE_PARTIALS,
  FRONT_DESK_TEMPLATE_FILE_REDIRECTS,
  frontDeskTemplateRedirect,
  registerFrontDeskHomeWorkPages,
  registerFrontDeskAuxPages,
  FIRST_JOB_VOCABULARY_KEYS,
  ASK_VOCABULARY_KEYS,
  PRESENCE_STUDIO_VOCABULARY_KEYS,
  renderFrontDeskPageTemplate,
  resolveFrontDeskPageLocale,
} from './front-desk-pages.js';

const STATIC_DIR = 'presence/displays/presence-studio/static';
const SHELL_PAGES = [
  'home.html',
  'ask.html',
  'progress.html',
  'help.html',
  'index.html',
  'first-job.html',
];
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
    expect(Object.keys(FRONT_DESK_TEMPLATE_FILE_REDIRECTS).sort()).toEqual(
      PAGES.map((page) => `/${page}`).sort()
    );
    expect(frontDeskTemplateRedirect('/home.html')).toBe('/');
    expect(frontDeskTemplateRedirect('/progress.html?tenant=acme#x')).toBe(
      '/progress?tenant=acme#x'
    );
    expect(frontDeskTemplateRedirect('/ui-gallery.html')).toBeNull();
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
    const firstJob = fakeRes();
    routes.get('/first-job')!({ headers: { 'accept-language': 'ja' } }, firstJob);
    expect(String(firstJob.sent)).toContain('<html lang="ja"');
    expect(String(firstJob.sent)).not.toMatch(/{{(t|partial|locale)[:}]/);
    expect(String(firstJob.sent)).toContain('#first-job-approval-panel');
    expect(String(firstJob.sent)).toContain('/login?next=%2Ffirst-job');
    expect(String(firstJob.sent)).not.toContain('/work#approval-panel');
    expect(String(firstJob.sent)).not.toContain('first-job-new-request');
    expect(String(firstJob.sent)).toContain(
      'pnpm onboarding first-job --tenant &lt;test-tenant&gt;'
    );
    expect(readStatic('home.html')).toContain('href="/first-job"');
    for (const key of FIRST_JOB_VOCABULARY_KEYS)
      expect(PRESENCE_STUDIO_VOCABULARY_KEYS).toContain(key);
    const home = fakeRes();
    routes.get('/')!({ headers: { 'accept-language': 'ja' } }, home);
    expect(String(home.sent)).toContain('<html lang="ja"');
    expect(String(home.sent)).not.toMatch(/\{\{(t|partial|locale)[:}]/);
  });
});

describe('First-job setup vocabulary delivery', () => {
  it('delivers every dynamically selected setup message through the browser vocabulary endpoint', () => {
    const catalog = loadVocabularyCatalog();
    expect(catalog).not.toBeNull();
    const keys = Object.keys(catalog!.domains.front_desk).filter(
      (key) => key.startsWith('first_job_setup_') || key.startsWith('first_job_next_')
    );
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const qualified = ('front_desk:' + key) as VocabularyKey;
      expect(FIRST_JOB_VOCABULARY_KEYS).toContain(qualified);
      expect(PRESENCE_STUDIO_VOCABULARY_KEYS).toContain(qualified);
      for (const locale of ['en', 'ja', 'qps-ploc'] as const) {
        expect(catalogT(qualified, undefined, locale)).not.toBe(qualified);
        expect(catalogT(qualified, undefined, locale)).not.toBe('');
      }
    }
  });
});

describe('First-job receipt viewer chrome', () => {
  it('labels each exact-body selector and scrollable plain-text pane in all supported locales', () => {
    const source = readStatic('first-job.html');
    for (const locale of ['en', 'ja'] as const) {
      const html = renderFrontDeskPageTemplate(source, locale, readStatic);
      expect(html).not.toMatch(/\{\{(t|partial|locale)[:}]/);
      for (const slot of ['body', 'left', 'right']) {
        expect(html).toContain('for="first-job-' + slot + '-select"');
        expect(html).toContain('id="first-job-' + slot + '-select"');
        expect(html).toMatch(new RegExp('<pre\\s+id="first-job-' + slot + '-content"'));
        expect(html).toContain('id="first-job-' + slot + '-metadata"');
      }
      for (const part of ['last-checked', 'refresh-mode', 'refresh-error', 'compare-status'])
        expect(html).toContain('id="first-job-' + part + '"');
      expect(html).not.toMatch(/file:\/\/|href="[^" ]*artifact_path/);
    }
    for (const match of source.matchAll(/\{\{t:(front_desk:first_job_[a-z0-9_]+)\}\}/g)) {
      expect(FIRST_JOB_VOCABULARY_KEYS).toContain(match[1]);
    }
    for (const key of FIRST_JOB_VOCABULARY_KEYS) {
      for (const locale of ['en', 'ja', 'qps-ploc'] as const) {
        expect(catalogT(key, undefined, locale)).not.toBe(key);
        expect(catalogT(key, undefined, locale)).not.toBe('');
      }
    }
    expect(readStatic('home.css')).toContain('@media (max-width: 48rem)');
    expect(readStatic('home.css')).toContain('white-space: pre-wrap');
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

describe('Progress correction helper delivery', () => {
  it('loads the correction helper before Progress and serves localized scope copy', () => {
    for (const locale of ['en', 'ja'] as const) {
      const html = renderFrontDeskPageTemplate(readStatic('progress.html'), locale, readStatic);
      expect(html.indexOf('src="/progress-correction.js"')).toBeGreaterThan(-1);
      expect(html.indexOf('src="/progress-correction.js"')).toBeLessThan(
        html.indexOf('src="/progress.js"')
      );
    }
    expect(readStatic('progress-correction.js')).toContain('window.KyberionProgressCorrection');
  });
});
