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
      'front-desk-rail.css',
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
