// UI-09 (SURFACE_UI_UNIFICATION_PLAN_2026-09-23 §6): the computer-surface
// page and the shared vanilla renderer it runs on.
//
//   GET /  (and /index.html)                -> static/index.html, filled for the viewer's locale
//   GET /shared-ui/kyberion-ui.js           -> libs/shared-ui/vanilla/kyberion-ui.js
//   GET /shared-ui/{charts,forms}.js        -> libs/shared-ui/vanilla/<file> (allow-list)
//   GET /shared-ui/messages/<locale>.json   -> { ok, locale, messages }  (`ui` domain bundle)
//
// Same shape as presence-studio's `ui-gallery-routes.ts`: every route maps to
// a fixed file — no path parameter reaches the filesystem, no directory of
// `libs/` is mounted — and nothing here reads API data or needs auth.
//
// The page is a small template so its chrome is already in the viewer's
// language at first paint (no unlabeled boxes while the script loads):
// `{{t:<domain>:<key>}}` becomes the HTML-escaped catalog text,
// `{{locale}}` the resolved locale, and `{{vocabulary-json}}` the page's
// own strings plus the renderer's `ui` bundle for the inline script.
//
// Developer sandbox: the A2UI dispatch sandbox (the block between the
// `dev-sandbox:begin` / `dev-sandbox:end` markers) is only sent when the page
// is opened with `?dev=1`. Without it the markup is not in the page at all.
// The flag is display-only — `POST /a2ui/dispatch` keeps its own
// `computer_surface.a2ui.dispatch` authorization either way.
import * as path from 'node:path';
import type express from 'express';
import { getUiMessageBundle, pathResolver, safeReadFile } from '@agent/core';
import { SUPPORTED_LOCALES, type SupportedLocale } from '@agent/core/locale-normalize';
import { t as catalogT, type VocabularyKey } from '@agent/core/t';
import { resolveVocabularyEntry } from '@agent/core/vocabulary-catalog';

export const COMPUTER_SURFACE_PAGE_FILE = 'index.html';
export const COMPUTER_SURFACE_LOCALE_COOKIE = 'kb-ui-locale';
export type ComputerSurfacePageLocale = 'en' | 'ja';

export const SHARED_UI_VANILLA_ROUTE = '/shared-ui/kyberion-ui.js';
export const SHARED_UI_VANILLA_SOURCE = 'libs/shared-ui/vanilla/kyberion-ui.js';
export const SHARED_UI_MODULE_ROUTE = '/shared-ui/:file';
export const SHARED_UI_MESSAGES_ROUTE = '/shared-ui/messages/:file';
export const SHARED_UI_MODULE_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  'charts.js': 'libs/shared-ui/vanilla/charts.js',
  'forms.js': 'libs/shared-ui/vanilla/forms.js',
});

/**
 * Exactly the keys the page script (`static/index.html`) reads from the
 * embedded vocabulary. Server-rendered chrome uses `{{t:…}}` directly.
 */
export const COMPUTER_SURFACE_SCRIPT_VOCABULARY_KEYS = [
  'computer_surface:conn_live',
  'computer_surface:conn_retrying',
  'computer_surface:conn_offline',
  'computer_surface:conn_pending',
  'computer_surface:updated_waiting',
  'computer_surface:updated_at',
  'computer_surface:identity_onboarding_required',
  'computer_surface:identity_trust_tier',
  'computer_surface:tenant_badge',
  'computer_surface:tenant_none',
  'computer_surface:first_run_greeting',
  'computer_surface:executor_browser',
  'computer_surface:executor_terminal',
  'computer_surface:executor_system',
  'computer_surface:status_idle',
  'computer_surface:detail_empty',
  'computer_surface:label_screenshot',
  'computer_surface:label_metadata',
  'computer_surface:intent_none',
  'computer_surface:os_col_operation',
  'computer_surface:os_col_status',
  'computer_surface:os_col_mission',
  'computer_surface:os_col_tenant',
  'computer_surface:os_col_submitted_by',
  'computer_surface:os_col_reversibility',
  'computer_surface:os_col_submitted_at',
  'computer_surface:os_col_service',
  'computer_surface:os_col_tier',
  'computer_surface:os_col_resource',
  'computer_surface:os_col_purpose',
  'computer_surface:os_col_summary',
  'computer_surface:os_col_observed_at',
  'computer_surface:os_reversible',
  'computer_surface:os_irreversible',
  'computer_surface:os_held_empty',
  'computer_surface:os_observations_empty',
  'computer_surface:os_unavailable',
  'computer_surface:os_human_action_title',
  'computer_surface:os_open_guarded',
  'computer_surface:os_configure_guarded',
  'computer_surface:dev_invalid_json',
  'computer_surface:dev_dispatching',
  'computer_surface:dev_ok',
  'computer_surface:dev_failed',
  'tui:tui_cockpit_authority_autonomous',
  'tui:tui_cockpit_authority_approval',
  'tui:tui_cockpit_authority_clarification',
  'tui:tui_cockpit_outcome_answer',
  'tui:tui_cockpit_outcome_artifact',
  'tui:tui_cockpit_outcome_approval_ready_plan',
  'tui:tui_cockpit_outcome_service_change',
  'tui:tui_cockpit_outcome_status_report',
] as const satisfies readonly VocabularyKey[];

const TEMPLATE_KEY_PATTERN = /\{\{t:([a-z0-9_]+:[a-z0-9_]+)\}\}/g;
const DEV_SANDBOX_BLOCK = /<!-- dev-sandbox:begin -->[\s\S]*?<!-- dev-sandbox:end -->/g;

function escapeTemplateText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** JSON safe to embed in a `<script type="application/json">` element. */
export function toInlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * The page language: the shared `kb-ui-locale` cookie when it names a
 * supported locale, else the first matching `Accept-Language` tag, else English.
 */
export function resolveComputerSurfacePageLocale(headers: {
  cookie?: string | string[];
  'accept-language'?: string | string[];
}): ComputerSurfacePageLocale {
  const cookie = Array.isArray(headers.cookie) ? headers.cookie.join(';') : headers.cookie || '';
  const match = /(?:^|;)\s*kb-ui-locale=(en|ja)\s*(?:;|$)/.exec(cookie);
  if (match) return match[1] as ComputerSurfacePageLocale;
  const accept = Array.isArray(headers['accept-language'])
    ? headers['accept-language'].join(',')
    : headers['accept-language'] || '';
  for (const part of accept.split(',')) {
    const tag = part.split(';')[0].trim().toLowerCase();
    if (tag.startsWith('ja')) return 'ja';
    if (tag.startsWith('en')) return 'en';
  }
  return 'en';
}

/** Developer sandbox flag: exactly `?dev=1` (a single value). */
export function isComputerSurfaceDevMode(query: unknown): boolean {
  if (!query || typeof query !== 'object') return false;
  return (query as Record<string, unknown>).dev === '1';
}

/** Raw (un-interpolated) catalog text for the page script; `{name}` placeholders stay. */
function rawVocabularyText(key: VocabularyKey, locale: SupportedLocale): string {
  const resolved = resolveVocabularyEntry(key);
  const text = resolved?.entry[locale] ?? resolved?.entry.en;
  return typeof text === 'string' && text ? text : key;
}

export interface ComputerSurfacePageVocabulary {
  locale: ComputerSurfacePageLocale;
  texts: Record<string, string>;
  messages: Record<string, string>;
}

export function buildComputerSurfacePageVocabulary(
  locale: ComputerSurfacePageLocale
): ComputerSurfacePageVocabulary {
  return {
    locale,
    texts: Object.fromEntries(
      COMPUTER_SURFACE_SCRIPT_VOCABULARY_KEYS.map((key) => [key, rawVocabularyText(key, locale)])
    ),
    messages: getUiMessageBundle(locale).messages,
  };
}

/** Fill the page template for `locale` (pure apart from catalog reads; exported for tests). */
export function renderComputerSurfacePage(
  html: string,
  locale: ComputerSurfacePageLocale,
  options: { dev?: boolean } = {}
): string {
  const dev = options.dev === true;
  const withSandbox = dev ? html : html.replace(DEV_SANDBOX_BLOCK, '');
  return withSandbox
    .replace(/\{\{locale\}\}/g, locale)
    .replace(/\{\{dev\}\}/g, dev ? 'true' : 'false')
    .replace(/\{\{vocabulary-json\}\}/g, () =>
      toInlineJson(buildComputerSurfacePageVocabulary(locale))
    )
    .replace(TEMPLATE_KEY_PATTERN, (_match, key: string) =>
      escapeTemplateText(catalogT(key as VocabularyKey, undefined, locale))
    );
}

/** `<locale>.json` -> the locale when it is exactly a supported one; otherwise null. */
export function parseLocaleFile(file: unknown): SupportedLocale | null {
  if (typeof file !== 'string') return null;
  const match = /^([a-z]{2,3}(?:-[a-z0-9]{2,8})?)\.json$/i.exec(file);
  if (!match) return null;
  return (SUPPORTED_LOCALES as readonly string[]).includes(match[1])
    ? (match[1] as SupportedLocale)
    : null;
}

function sendScript(res: express.Response, source: string): void {
  res.type('text/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(pathResolver.rootResolve(source));
}

/**
 * Register the page and shared-ui routes. Must run before `express.static`
 * so the raw template is never served unfilled.
 */
export function registerComputerSurfacePageRoutes(app: express.Express, staticDir: string): void {
  const sendPage = (req: express.Request, res: express.Response) => {
    const locale = resolveComputerSurfacePageLocale(req.headers);
    const html = String(
      safeReadFile(path.join(staticDir, COMPUTER_SURFACE_PAGE_FILE), { encoding: 'utf8' }) || ''
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Language', locale);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res
      .type('html')
      .send(renderComputerSurfacePage(html, locale, { dev: isComputerSurfaceDevMode(req.query) }));
  };
  app.get('/', sendPage);
  app.get(`/${COMPUTER_SURFACE_PAGE_FILE}`, sendPage);

  app.get(SHARED_UI_VANILLA_ROUTE, (_req, res) => sendScript(res, SHARED_UI_VANILLA_SOURCE));
  app.get(SHARED_UI_MESSAGES_ROUTE, (req, res) => {
    const locale = parseLocaleFile(req.params.file);
    if (!locale) return res.status(404).json({ ok: false, error: 'unsupported locale' });
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.json({ ok: true, ...getUiMessageBundle(locale) });
  });
  app.get(SHARED_UI_MODULE_ROUTE, (req, res) => {
    const file = typeof req.params.file === 'string' ? req.params.file : '';
    if (!Object.prototype.hasOwnProperty.call(SHARED_UI_MODULE_SOURCES, file)) {
      return res.status(404).json({ ok: false, error: 'unknown module' });
    }
    return sendScript(res, SHARED_UI_MODULE_SOURCES[file]);
  });
}
