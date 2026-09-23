// UI-04 (SURFACE_UI_UNIFICATION_PLAN_2026-09-23 §5): the kyberion-base
// component gallery and the shared vanilla renderer it runs on.
//
//   GET /ui-gallery                           -> static/ui-gallery.html
//   GET /shared-ui/kyberion-ui.js             -> libs/shared-ui/vanilla/kyberion-ui.js
//   GET /shared-ui/messages/<locale>.json     -> { ok, locale, messages }  (UI-01d)
//   GET /ui-gallery/vocabulary/<locale>.json  -> { ok, locale, texts }     (UI-01d)
//   GET /ui-gallery/fixtures/<locale>.json    -> merged sample data         (UI-01b)
//   GET /shared-ui/<module>.js                -> libs/shared-ui/vanilla/<file> (allow-list:
//        charts*.js, forms*.js, kyberion-ui-vocabulary.js — every module the renderer imports, transitively)
//   GET /shared-ui/speech-player.js           -> libs/shared-ui/vanilla/speech-player.js (PA-09:
//        a page-level module the renderer never imports; pages with a talking
//        avatar import it themselves, e.g. static/partner-avatar.js)
//
// The first two are fixed files (no path parameter reaches the filesystem),
// served like the other static front-desk pages: no API data, no auth, bound
// to the surface's loopback HOST. The renderer is a single explicit route
// rather than a directory mount so nothing else under libs/ becomes reachable.
//
// UI-01d: the two `<locale>.json` routes deliver public-tier vocabulary text
// (knowledge/product/orchestration/user-facing-vocabulary.json) to static
// pages, the same shape as the `/api/*-vocabulary` routes: the renderer's
// `ui:*` bundle (`getUiMessageBundle`, handed to `renderA2UI({ locale,
// messages })`) and the gallery's own chrome strings. `<locale>` must be
// exactly one of the catalog's supported locales; anything else is a 404, so
// the parameter never reaches anything but a fixed-list lookup.
import * as path from 'node:path';
import type express from 'express';
import { getUiMessageBundle, pathResolver, safeReaddir } from '@agent/core';
import { readJson } from '@agent/core/foundation';
import { SUPPORTED_LOCALES, type SupportedLocale } from '@agent/core/locale-normalize';
import { t as catalogT, type VocabularyKey } from '@agent/core/t';

export const UI_GALLERY_ROUTE = '/ui-gallery';
export const SHARED_UI_VANILLA_ROUTE = '/shared-ui/kyberion-ui.js';
export const SHARED_UI_VANILLA_SOURCE = 'libs/shared-ui/vanilla/kyberion-ui.js';
export const SHARED_UI_MESSAGES_ROUTE = '/shared-ui/messages/:file';
export const UI_GALLERY_VOCABULARY_ROUTE = '/ui-gallery/vocabulary/:file';
// UI-01b / UI-01c: the renderer imports sibling modules (`./charts.js`,
// `./forms.js`, which import their own `charts-*.js` / `forms-*.js` parts),
// served next to it from a fixed allow-list of exactly that transitive set
// (the `:file` parameter only ever selects one of these entries).
export const SHARED_UI_MODULE_ROUTE = '/shared-ui/:file';
export const SHARED_UI_MODULE_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  'charts.js': 'libs/shared-ui/vanilla/charts.js',
  'charts-core.js': 'libs/shared-ui/vanilla/charts-core.js',
  'charts-scale.js': 'libs/shared-ui/vanilla/charts-scale.js',
  'charts-cartesian.js': 'libs/shared-ui/vanilla/charts-cartesian.js',
  'charts-compact.js': 'libs/shared-ui/vanilla/charts-compact.js',
  'charts-diagram.js': 'libs/shared-ui/vanilla/charts-diagram.js',
  'forms.js': 'libs/shared-ui/vanilla/forms.js',
  'forms-core.js': 'libs/shared-ui/vanilla/forms-core.js',
  'forms-camera.js': 'libs/shared-ui/vanilla/forms-camera.js',
  'kyberion-ui-vocabulary.js': 'libs/shared-ui/vanilla/kyberion-ui-vocabulary.js',
  // PA-02 voice
  'voice.js': 'libs/shared-ui/vanilla/voice.js',
  'voice-controller.js': 'libs/shared-ui/vanilla/voice-controller.js',
  // PA-01 pads
  'pads.js': 'libs/shared-ui/vanilla/pads.js',
  'toolbar.js': 'libs/shared-ui/vanilla/toolbar.js',
  'dialog.js': 'libs/shared-ui/vanilla/dialog.js',
  'drawing.js': 'libs/shared-ui/vanilla/drawing.js',
  'drawing-core.js': 'libs/shared-ui/vanilla/drawing-core.js',
  'drawing-engine.js': 'libs/shared-ui/vanilla/drawing-engine.js',
  // PA-09 talking avatar
  'avatar.js': 'libs/shared-ui/vanilla/avatar.js',
  'lipsync.js': 'libs/shared-ui/vanilla/lipsync.js',
});
// PA-09: page-level vanilla modules outside the renderer's import graph, each
// on its own fixed route (registered ahead of `/shared-ui/:file`). They must
// not import anything (so nothing else becomes reachable through them).
export const SHARED_UI_PAGE_MODULE_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  'speech-player.js': 'libs/shared-ui/vanilla/speech-player.js',
});
// Gallery sample data: `ui-gallery.fixtures.<locale>.json` (base, with the
// sample screen) plus every `ui-gallery.fixtures.<part>.<locale>.json`
// (charts, forms, ...) merged in part-name order, so a new component group
// only adds files.
export const UI_GALLERY_FIXTURES_ROUTE = '/ui-gallery/fixtures/:file';
/** Locales with their own sample data; others (qps-ploc) reuse English. */
export const UI_GALLERY_FIXTURE_LOCALES = ['en', 'ja'] as const;

// Exactly the gallery chrome keys `static/ui-gallery.js` / `ui-gallery.html`
// render (`data-i18n` attributes). Component text comes from the per-locale
// fixture files; renderer defaults come from the `ui` bundle above.
export const UI_GALLERY_VOCABULARY_KEYS = [
  'presence_studio:ui_gallery_page_title',
  'presence_studio:ui_gallery_title',
  'presence_studio:ui_gallery_subtitle',
  'presence_studio:ui_gallery_language',
  'presence_studio:ui_gallery_theme',
  'presence_studio:ui_gallery_theme_light',
  'presence_studio:ui_gallery_theme_dark',
  'presence_studio:ui_gallery_density',
  'presence_studio:ui_gallery_density_comfortable',
  'presence_studio:ui_gallery_density_compact',
  'presence_studio:ui_gallery_sample_screen',
  'presence_studio:ui_gallery_index_label',
  'presence_studio:ui_gallery_action',
  'presence_studio:ui_gallery_load_failed',
] as const satisfies readonly VocabularyKey[];

/** `<locale>.json` -> the locale when it is exactly a supported one; otherwise null. */
export function parseLocaleFile(file: unknown): SupportedLocale | null {
  if (typeof file !== 'string') return null;
  const match = /^([a-z]{2,3}(?:-[a-z0-9]{2,8})?)\.json$/i.exec(file);
  if (!match) return null;
  return (SUPPORTED_LOCALES as readonly string[]).includes(match[1])
    ? (match[1] as SupportedLocale)
    : null;
}

export function buildUiGalleryVocabulary(locale: SupportedLocale): Record<string, string> {
  return Object.fromEntries(
    UI_GALLERY_VOCABULARY_KEYS.map((key) => [key, catalogT(key, undefined, locale)])
  );
}

export interface UiGalleryFixtureSection {
  id: string;
  title: string;
  description?: string;
  components: unknown[];
}

export interface UiGalleryFixtures {
  version: number;
  catalog: string;
  sample_screen: { title: string; description?: string; root: string; components: unknown[] };
  sections: UiGalleryFixtureSection[];
}

/** Fixture files for `locale`: the base file first, then the part files sorted by name. */
export function listUiGalleryFixtureFiles(staticDir: string, locale: string): string[] {
  const part = /^ui-gallery\.fixtures\.([a-z0-9-]+)\.([a-z]{2,3}(?:-[a-z0-9]{2,8})?)\.json$/;
  const parts = safeReaddir(staticDir)
    .filter((name) => {
      const match = part.exec(name);
      return Boolean(match && match[2] === locale && match[1] !== locale);
    })
    .sort();
  return [`ui-gallery.fixtures.${locale}.json`, ...parts];
}

/** Base fixtures with every part file's sections appended (part-name order). */
export function loadUiGalleryFixtures(staticDir: string, locale: string): UiGalleryFixtures {
  const [baseFile, ...partFiles] = listUiGalleryFixtureFiles(staticDir, locale);
  const read = <T>(file: string): T => readJson<T>(path.join(staticDir, file));
  const base = read<UiGalleryFixtures>(baseFile);
  const sections = [...base.sections];
  for (const file of partFiles) {
    const part = read<{ sections?: UiGalleryFixtureSection[] }>(file);
    sections.push(...(Array.isArray(part.sections) ? part.sections : []));
  }
  return { ...base, sections };
}

export function registerUiGalleryRoutes(app: express.Express, staticDir: string): void {
  app.get(UI_GALLERY_ROUTE, (_req, res) => {
    res.sendFile(path.join(staticDir, 'ui-gallery.html'));
  });
  app.get(SHARED_UI_VANILLA_ROUTE, (_req, res) => {
    res.type('text/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(pathResolver.rootResolve(SHARED_UI_VANILLA_SOURCE));
  });
  for (const [file, source] of Object.entries(SHARED_UI_PAGE_MODULE_SOURCES)) {
    app.get(`/shared-ui/${file}`, (_req, res) => {
      res.type('text/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(pathResolver.rootResolve(source));
    });
  }
  app.get(SHARED_UI_MODULE_ROUTE, (req, res) => {
    const file = typeof req.params.file === 'string' ? req.params.file : '';
    if (!Object.prototype.hasOwnProperty.call(SHARED_UI_MODULE_SOURCES, file)) {
      return res.status(404).json({ ok: false, error: 'unknown module' });
    }
    res.type('text/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    return res.sendFile(pathResolver.rootResolve(SHARED_UI_MODULE_SOURCES[file]));
  });
  app.get(UI_GALLERY_FIXTURES_ROUTE, (req, res) => {
    const locale = parseLocaleFile(req.params.file);
    if (!locale) return res.status(404).json({ ok: false, error: 'unsupported locale' });
    const fixtureLocale = (UI_GALLERY_FIXTURE_LOCALES as readonly string[]).includes(locale)
      ? locale
      : 'en';
    res.setHeader('Cache-Control', 'no-cache');
    return res.json(loadUiGalleryFixtures(staticDir, fixtureLocale));
  });
  app.get(SHARED_UI_MESSAGES_ROUTE, (req, res) => {
    const locale = parseLocaleFile(req.params.file);
    if (!locale) return res.status(404).json({ ok: false, error: 'unsupported locale' });
    res.setHeader('Cache-Control', 'no-cache');
    return res.json({ ok: true, ...getUiMessageBundle(locale) });
  });
  app.get(UI_GALLERY_VOCABULARY_ROUTE, (req, res) => {
    const locale = parseLocaleFile(req.params.file);
    if (!locale) return res.status(404).json({ ok: false, error: 'unsupported locale' });
    res.setHeader('Cache-Control', 'no-cache');
    return res.json({ ok: true, locale, texts: buildUiGalleryVocabulary(locale) });
  });
}
