// UI-04 (SURFACE_UI_UNIFICATION_PLAN_2026-09-23 §5): the kyberion-base
// component gallery and the shared vanilla renderer it runs on.
//
//   GET /ui-gallery                           -> static/ui-gallery.html
//   GET /shared-ui/kyberion-ui.js             -> libs/shared-ui/vanilla/kyberion-ui.js
//   GET /shared-ui/messages/<locale>.json     -> { ok, locale, messages }  (UI-01d)
//   GET /ui-gallery/vocabulary/<locale>.json  -> { ok, locale, texts }     (UI-01d)
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
import { getUiMessageBundle, pathResolver } from '@agent/core';
import { SUPPORTED_LOCALES, type SupportedLocale } from '@agent/core/locale-normalize';
import { t as catalogT, type VocabularyKey } from '@agent/core/t';

export const UI_GALLERY_ROUTE = '/ui-gallery';
export const SHARED_UI_VANILLA_ROUTE = '/shared-ui/kyberion-ui.js';
export const SHARED_UI_VANILLA_SOURCE = 'libs/shared-ui/vanilla/kyberion-ui.js';
export const SHARED_UI_MESSAGES_ROUTE = '/shared-ui/messages/:file';
export const UI_GALLERY_VOCABULARY_ROUTE = '/ui-gallery/vocabulary/:file';

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

export function registerUiGalleryRoutes(app: express.Express, staticDir: string): void {
  app.get(UI_GALLERY_ROUTE, (_req, res) => {
    res.sendFile(path.join(staticDir, 'ui-gallery.html'));
  });
  app.get(SHARED_UI_VANILLA_ROUTE, (_req, res) => {
    res.type('text/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(pathResolver.rootResolve(SHARED_UI_VANILLA_SOURCE));
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
