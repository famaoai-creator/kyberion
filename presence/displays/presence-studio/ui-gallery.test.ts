// UI-04: `/ui-gallery` + `/shared-ui/kyberion-ui.js` (presence-studio).
// UI-01d: per-locale fixtures (en / ja, identical shape), the `ui` message
// bundle route and the gallery chrome vocabulary route.
//
// Like the other route contract tests here, this never imports `server.ts`
// (it listens at module scope). It exercises `registerUiGalleryRoutes`
// against a recording app, reads the runtime module as text to prove the
// wiring, and validates the gallery fixture against the kyberion-base
// catalog schema so gallery data can never drift from the catalog.
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getUiMessageBundle, pathResolver, safeExistsSync, safeReadFile } from '@agent/core';
import {
  A2UI_BASE_COMPONENT_TYPES,
  isKyberionBaseComponentType,
  validateA2UIComponentProps,
} from '@agent/core/a2ui-catalog';
import {
  SHARED_UI_MESSAGES_ROUTE,
  SHARED_UI_MODULE_ROUTE,
  SHARED_UI_MODULE_SOURCES,
  SHARED_UI_PAGE_MODULE_SOURCES,
  SHARED_UI_VANILLA_ROUTE,
  SHARED_UI_VANILLA_SOURCE,
  UI_GALLERY_ROUTE,
  UI_GALLERY_VOCABULARY_KEYS,
  UI_GALLERY_FIXTURES_ROUTE,
  UI_GALLERY_VOCABULARY_ROUTE,
  listUiGalleryFixtureFiles,
  loadUiGalleryFixtures,
  parseLocaleFile,
  registerUiGalleryRoutes,
} from './ui-gallery-routes.js';

const STATIC_DIR = 'presence/displays/presence-studio/static';

function readRepoFile(relativePath: string): string {
  return String(safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' }));
}

interface FixtureComponent {
  id: string;
  type: string;
  props: Record<string, unknown>;
  children?: string[];
}

interface GalleryFixtures {
  version: number;
  catalog: string;
  sample_screen: { title: string; root: string; components: FixtureComponent[] };
  sections: Array<{ id: string; title: string; components: FixtureComponent[] }>;
}

const FIXTURE_LOCALES = ['en', 'ja'] as const;

/** Base fixtures + every `ui-gallery.fixtures.<part>.<locale>.json` (what the gallery serves). */
function loadFixtures(locale: string): GalleryFixtures {
  return loadUiGalleryFixtures(pathResolver.rootResolve(STATIC_DIR), locale) as GalleryFixtures;
}

// Keys whose values are structure / vocabulary, not display text: they must be
// identical in every locale's fixture. Every other string is translated text.
const STRUCTURAL_KEYS = new Set([
  'version',
  'catalog',
  'root',
  'id',
  'type',
  'children',
  'href',
  'key',
  'status',
  'domain',
  'variant',
  'tone',
  'role',
  'icon',
  'state',
  'shape',
  'align',
  'trend',
  'overflow',
  'active',
  'row_href_key',
  'gap',
  'direction',
  'min_column_width',
  'density',
  'theme',
  'mono',
  'width',
  'open',
  'disabled',
  'wrap',
  'columns',
  'lines',
  // UI-01b charts: identifiers / enums, identical in every locale.
  'orientation',
  'scale',
  'kind',
  'from',
  'to',
  'stage',
]);

/** Replace display-text leaves with a placeholder so only the shape remains. */
function shapeOf(value: unknown, key?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => shapeOf(item, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, shapeOf(v, k)])
    );
  }
  if (typeof value === 'string' && !(key && STRUCTURAL_KEYS.has(key))) return '<text>';
  return value;
}

describe('ui-gallery fixtures: base + part files', () => {
  it('loads the base file first and every part file for the locale', () => {
    const root = pathResolver.rootResolve(STATIC_DIR);
    for (const locale of FIXTURE_LOCALES) {
      const files = listUiGalleryFixtureFiles(root, locale);
      expect(files[0]).toBe(`ui-gallery.fixtures.${locale}.json`);
      expect(files).toContain(`ui-gallery.fixtures.charts.${locale}.json`);
      expect(files.every((file) => file.endsWith(`.${locale}.json`))).toBe(true);
    }
    // Every locale has the same parts.
    const strip = (locale: string) =>
      listUiGalleryFixtureFiles(root, locale).map((file) => file.replace(`.${locale}.json`, ''));
    expect(strip('ja')).toEqual(strip('en'));
    expect(loadFixtures('en').sections.map((s) => s.id)).toContain('sequence');
  });
});

describe('ui-gallery fixtures: en and ja have the identical shape', () => {
  it('differ only in display text', () => {
    const [en, ja] = FIXTURE_LOCALES.map(loadFixtures);
    expect(shapeOf(en)).toEqual(shapeOf(ja));
    expect(JSON.stringify(en)).not.toMatch(/[\u3040-\u30ff]/u);
    expect(JSON.stringify(ja)).toMatch(/[\u3040-\u30ff]/u);
  });
});

for (const locale of FIXTURE_LOCALES) {
  const fixtures = loadFixtures(locale);
  const componentLists: Array<[string, FixtureComponent[]]> = [
    ['sample_screen', fixtures.sample_screen.components],
    ...fixtures.sections.map((s): [string, FixtureComponent[]] => [s.id, s.components]),
  ];

  describe(`ui-gallery fixtures (${locale})`, () => {
    it('targets the kyberion-base catalog', () => {
      expect(fixtures.catalog).toBe('kyberion-base');
      expect(new Set(fixtures.sections.map((s) => s.id)).size).toBe(fixtures.sections.length);
    });

    for (const [listId, components] of componentLists) {
      it(`${listId}: every component is a catalog type with schema-valid props`, () => {
        for (const component of components) {
          expect(isKyberionBaseComponentType(component.type), `${listId}/${component.id}`).toBe(
            true
          );
          expect(
            () => validateA2UIComponentProps(component.type as never, component.props),
            `${listId}/${component.id}`
          ).not.toThrow();
        }
      });

      it(`${listId}: ids are unique and every child reference resolves`, () => {
        const ids = components.map((c) => c.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const component of components) {
          for (const child of component.children ?? []) {
            expect(ids, `${listId}/${component.id} -> ${child}`).toContain(child);
          }
        }
      });
    }

    it('shows every catalog type at least once', () => {
      const shown = new Set(componentLists.flatMap(([, list]) => list.map((c) => c.type)));
      const missing = A2UI_BASE_COMPONENT_TYPES.filter((type) => !shown.has(type));
      expect(missing).toEqual([]);
    });

    it('composes the sample screen from an app-shell root with the key building blocks', () => {
      const { root, components } = fixtures.sample_screen;
      const byId = new Map(components.map((c) => [c.id, c]));
      expect(byId.get(root)?.type).toBe('ui:app-shell');
      const types = new Set(components.map((c) => c.type));
      for (const type of [
        'ui:nav-rail',
        'ui:page-header',
        'ui:next-action',
        'ui:metric',
        'ui:table',
        'ui:callout',
        'ui:empty-state',
      ]) {
        expect(types.has(type), type).toBe(true);
      }
      const header = components.find((c) => c.type === 'ui:page-header');
      expect(header?.props.role_badge).toBeTruthy();
    });
  });
}

describe('ui-gallery routes', () => {
  function recordRoutes() {
    const routes = new Map<string, (req: unknown, res: unknown) => void>();
    const app = {
      get(route: string, handler: (req: unknown, res: unknown) => void) {
        routes.set(route, handler);
      },
    };
    registerUiGalleryRoutes(app as never, '/static-root');
    return routes;
  }

  function jsonResponse() {
    const res = {
      statusCode: 200,
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
      setHeader(name: string, value: string) {
        res.headers[name] = value;
      },
    };
    return res;
  }

  function fakeResponse() {
    const res = {
      sent: '',
      contentType: '',
      headers: {} as Record<string, string>,
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

  it('serves the gallery page and the vanilla renderer from fixed files', () => {
    const routes = recordRoutes();
    expect([...routes.keys()].sort()).toEqual(
      [
        SHARED_UI_MESSAGES_ROUTE,
        SHARED_UI_MODULE_ROUTE,
        SHARED_UI_VANILLA_ROUTE,
        UI_GALLERY_FIXTURES_ROUTE,
        UI_GALLERY_ROUTE,
        UI_GALLERY_VOCABULARY_ROUTE,
        ...Object.keys(SHARED_UI_PAGE_MODULE_SOURCES).map((file) => `/shared-ui/${file}`),
      ].sort()
    );

    const page = fakeResponse();
    routes.get(UI_GALLERY_ROUTE)!({}, page);
    expect(page.sent).toBe(path.join('/static-root', 'ui-gallery.html'));

    const script = fakeResponse();
    routes.get(SHARED_UI_VANILLA_ROUTE)!({}, script);
    expect(script.sent).toBe(pathResolver.rootResolve(SHARED_UI_VANILLA_SOURCE));
    expect(script.contentType).toMatch(/^text\/javascript/);
    expect(safeExistsSync(script.sent)).toBe(true);
  });

  it('serves only allow-listed sibling renderer modules (charts*.js, forms*.js)', () => {
    const routes = recordRoutes();
    const module = fakeResponse();
    routes.get(SHARED_UI_MODULE_ROUTE)!({ params: { file: 'charts.js' } }, module);
    expect(module.sent).toBe(pathResolver.rootResolve(SHARED_UI_MODULE_SOURCES['charts.js']));
    expect(module.contentType).toMatch(/^text\/javascript/);
    for (const source of Object.values(SHARED_UI_MODULE_SOURCES)) {
      expect(safeExistsSync(pathResolver.rootResolve(source)), source).toBe(true);
    }
    // The allow-list is exactly the renderer's transitive sibling imports, so
    // the browser can load every module and nothing else is reachable.
    const seen = new Set<string>();
    const queue = [SHARED_UI_VANILLA_SOURCE];
    while (queue.length) {
      const source = readRepoFile(queue.shift()!);
      for (const [, file] of source.matchAll(/from '\.\/([\w-]+\.js)'/g)) {
        if (seen.has(file)) continue;
        seen.add(file);
        queue.push(`libs/shared-ui/vanilla/${file}`);
      }
    }
    expect([...seen].sort()).toEqual(Object.keys(SHARED_UI_MODULE_SOURCES).sort());
    // PA-09 page-level modules sit outside that graph and import nothing.
    for (const [file, source] of Object.entries(SHARED_UI_PAGE_MODULE_SOURCES)) {
      expect(seen.has(file), file).toBe(false);
      expect(readRepoFile(source), source).not.toMatch(/^\s*import\s/m);
      const res = fakeResponse();
      routes.get(`/shared-ui/${file}`)!({}, res);
      expect(res.sent).toBe(pathResolver.rootResolve(source));
      expect(res.contentType).toMatch(/^text\/javascript/);
    }
    for (const file of ['../x.js', 'kyberion-ui.test.ts', 'mini-dom.js', '']) {
      const res = jsonResponse();
      routes.get(SHARED_UI_MODULE_ROUTE)!({ params: { file } }, res);
      expect(res.statusCode, file).toBe(404);
    }
  });

  it('serves merged fixtures per supported locale (qps-ploc reuses en)', () => {
    const routes = recordRoutes();
    const staticRoot = pathResolver.rootResolve(STATIC_DIR);
    const real = new Map<string, (req: unknown, res: unknown) => void>();
    registerUiGalleryRoutes(
      {
        get: (route: string, handler: (req: unknown, res: unknown) => void) =>
          real.set(route, handler),
      } as never,
      staticRoot
    );
    expect(routes.has(UI_GALLERY_FIXTURES_ROUTE)).toBe(true);
    for (const [file, locale] of [
      ['en.json', 'en'],
      ['ja.json', 'ja'],
      ['qps-ploc.json', 'en'],
    ]) {
      const res = jsonResponse();
      real.get(UI_GALLERY_FIXTURES_ROUTE)!({ params: { file } }, res);
      expect(res.statusCode, file).toBe(200);
      expect(res.body).toEqual(loadFixtures(locale));
    }
    const bad = jsonResponse();
    real.get(UI_GALLERY_FIXTURES_ROUTE)!({ params: { file: '../en.json' } }, bad);
    expect(bad.statusCode).toBe(404);
  });

  it('serves the ui message bundle and gallery chrome text per supported locale only', () => {
    const routes = recordRoutes();
    for (const locale of ['en', 'ja']) {
      const bundle = jsonResponse();
      routes.get(SHARED_UI_MESSAGES_ROUTE)!({ params: { file: `${locale}.json` } }, bundle);
      expect(bundle.statusCode).toBe(200);
      expect(bundle.body).toEqual({ ok: true, ...getUiMessageBundle(locale as 'en' | 'ja') });
      const chrome = jsonResponse();
      routes.get(UI_GALLERY_VOCABULARY_ROUTE)!({ params: { file: `${locale}.json` } }, chrome);
      const texts = (chrome.body as { texts: Record<string, string> }).texts;
      expect(Object.keys(texts).sort()).toEqual([...UI_GALLERY_VOCABULARY_KEYS].sort());
      for (const key of UI_GALLERY_VOCABULARY_KEYS) expect(texts[key], key).not.toBe(key);
    }
    const ja = jsonResponse();
    routes.get(SHARED_UI_MESSAGES_ROUTE)!({ params: { file: 'ja.json' } }, ja);
    expect((ja.body as { messages: Record<string, string> }).messages['ui:table_empty']).toBe(
      'データがありません'
    );
    for (const file of ['fr.json', 'ja', '../ja.json', 'ja.json.map', 'JA-jp.json', '']) {
      const res = jsonResponse();
      routes.get(SHARED_UI_MESSAGES_ROUTE)!({ params: { file } }, res);
      expect(res.statusCode, file).toBe(404);
      expect(parseLocaleFile(file), file).toBeNull();
    }
    expect(parseLocaleFile('qps-ploc.json')).toBe('qps-ploc');
  });

  it('every gallery chrome key is used by the page and nothing else is', () => {
    const page = readRepoFile(`${STATIC_DIR}/ui-gallery.html`);
    const script = readRepoFile(`${STATIC_DIR}/ui-gallery.js`);
    const used = new Set(
      [...`${page}\n${script}`.matchAll(/presence_studio:ui_gallery_[a-z_]+/g)].map((m) => m[0])
    );
    expect([...used].sort()).toEqual([...UI_GALLERY_VOCABULARY_KEYS].sort());
    // No user-facing text in the gallery script: it all comes from the vocabulary.
    expect(script).not.toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/u);
    expect(script).toContain('/shared-ui/messages/${locale}.json');
    expect(script).toContain('/ui-gallery/fixtures/${locale}.json');
  });

  it('is wired into the presence-studio runtime', () => {
    const runtime = readRepoFile(
      'presence/displays/presence-studio/presence-studio-runtime-data.ts'
    );
    expect(runtime).toContain("import { registerUiGalleryRoutes } from './ui-gallery-routes.js';");
    expect(runtime).toContain('registerUiGalleryRoutes(app, staticDir);');
  });

  it('the page loads the shared tokens, component CSS and renderer', () => {
    const page = readRepoFile(`${STATIC_DIR}/ui-gallery.html`);
    expect(page).toContain('href="/design-tokens.css"');
    expect(page).toContain('href="/kyberion-ui.css"');
    expect(page).toContain('src="/ui-gallery.js"');
    const script = readRepoFile(`${STATIC_DIR}/ui-gallery.js`);
    expect(script).toContain(`from '${SHARED_UI_VANILLA_ROUTE}'`);
    expect(script).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write/);
  });

  it('the gallery stylesheet uses tokens only (no literal colors)', () => {
    const css = readRepoFile(`${STATIC_DIR}/ui-gallery.css`);
    expect(css.match(/#[0-9a-f]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/giu)).toBeNull();
  });
});

describe('ui-gallery-prefs.js applies the shared theme / language before paint', () => {
  const source = readRepoFile(`${STATIC_DIR}/ui-gallery-prefs.js`);

  interface PrefsRun {
    attrs: Map<string, string>;
    prefs: { theme: string | null; locale: string };
  }

  /** Run the blocking script against a fake page (`storage: null` = storage throws). */
  function runPrefs(options: {
    search?: string;
    storage?: Record<string, string> | null;
    language?: string;
  }): PrefsRun {
    const attrs = new Map<string, string>([
      ['lang', 'en'],
      ['data-density', 'comfortable'],
    ]);
    const documentElement = {
      setAttribute: (name: string, value: string) => attrs.set(name, value),
      removeAttribute: (name: string) => attrs.delete(name),
      getAttribute: (name: string) => attrs.get(name) ?? null,
    };
    const storage = options.storage;
    const win: Record<string, unknown> = {
      location: { search: options.search ?? '' },
    };
    Object.defineProperty(win, 'localStorage', {
      get() {
        if (storage === null) throw new Error('SecurityError');
        return { getItem: (key: string) => (storage ?? {})[key] ?? null };
      },
    });
    const run = new Function('window', 'document', 'navigator', 'URLSearchParams', source);
    run(
      win,
      { documentElement },
      { language: options.language ?? 'en-US', languages: [options.language ?? 'en-US'] },
      URLSearchParams
    );
    return { attrs, prefs: win.KyberionGalleryPrefs as PrefsRun['prefs'] };
  }

  it('loads before any stylesheet and the page no longer hard-codes light', () => {
    const page = readRepoFile(`${STATIC_DIR}/ui-gallery.html`);
    const prefsAt = page.indexOf('<script src="/ui-gallery-prefs.js"></script>');
    expect(prefsAt).toBeGreaterThan(-1);
    expect(prefsAt).toBeLessThan(page.indexOf('design-tokens.css'));
    expect(page).not.toMatch(/<html[^>]*data-theme=/);
    expect(source).toContain("THEME_KEY = 'kyberion.ui.theme'");
    expect(source).toContain("LOCALE_KEY = 'kyberion.ui.locale'");
    expect(readRepoFile(`${STATIC_DIR}/ui-gallery.js`)).toContain('window.KyberionGalleryPrefs');
  });

  it('first load uses the stored shared theme and language', () => {
    const run = runPrefs({ storage: { 'kyberion.ui.theme': 'dark', 'kyberion.ui.locale': 'ja' } });
    expect(run.attrs.get('data-theme')).toBe('dark');
    expect(run.attrs.get('lang')).toBe('ja');
    expect(run.prefs).toEqual({ theme: 'dark', locale: 'ja' });
  });

  it('?theme= and ?lang= override the stored choice', () => {
    const run = runPrefs({
      search: '?theme=light&lang=en',
      storage: { 'kyberion.ui.theme': 'dark', 'kyberion.ui.locale': 'ja' },
    });
    expect(run.attrs.get('data-theme')).toBe('light');
    expect(run.attrs.get('lang')).toBe('en');
    const pseudo = runPrefs({ search: '?lang=qps-ploc', storage: {} });
    expect(pseudo.attrs.get('lang')).toBe('qps-ploc');
  });

  it('no stored theme follows the system (no data-theme); the browser language is the fallback', () => {
    const run = runPrefs({ storage: {}, language: 'ja-JP' });
    expect(run.attrs.has('data-theme')).toBe(false);
    expect(run.prefs).toEqual({ theme: null, locale: 'ja' });
    const invalid = runPrefs({
      search: '?theme=neon&lang=xx',
      storage: { 'kyberion.ui.theme': 'sepia', 'kyberion.ui.locale': 'fr' },
    });
    expect(invalid.attrs.has('data-theme')).toBe(false);
    expect(invalid.prefs.locale).toBe('en');
  });

  it('unavailable storage still renders with the defaults', () => {
    const run = runPrefs({ storage: null, search: '?theme=dark' });
    expect(run.attrs.get('data-theme')).toBe('dark');
    expect(run.prefs.locale).toBe('en');
  });
});
