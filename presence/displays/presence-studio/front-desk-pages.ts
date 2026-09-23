// Front-desk page-serving routes and the vocabulary key lists their pages
// render, split out of `presence-studio-runtime-data.ts` purely to keep that
// file under the repo's `max-file-lines` gate (knowledge/product/governance/
// max-file-lines.json) — no behavior change. Registered from the same two
// call sites `presence-studio-runtime-data.ts` used before this split:
// `registerFrontDeskHomeWorkPages` ahead of `express.static` (so its default
// `index: 'index.html'` never wins the race for `GET /`), and
// `registerFrontDeskAuxPages` after it (a literal `/ask`, `/progress`,
// `/help`, or `/onboarding` path never collides with `express.static`'s file
// lookup, which only matches an exact filename with no extension).
import type express from 'express';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';
import { readFrontDeskSurfacePorts } from '@agent/core/front-desk-nav';
import { t as catalogT, type VocabularyKey } from '@agent/core/t';

export const PRESENCE_STUDIO_VOCABULARY_KEYS = [
  'presence_studio:record_mission_placeholder',
  'presence_studio:record_start',
  'presence_studio:record_stop',
  'presence_studio:live_transcript',
  'presence_studio:record_hint',
  'presence_studio:record_panel_label',
  'presence_studio:notes_panel_label',
  'presence_studio:notes_placeholder',
  'presence_studio:meeting_title_placeholder',
  'presence_studio:create_minutes',
  'presence_studio:copy_notes',
  'presence_studio:restore_draft',
  'presence_studio:clear_notes',
  'presence_studio:notes_hint',
  'presence_studio:email_triage_label',
  'presence_studio:email_triage_empty',
  'presence_studio:refresh_triage',
  'presence_studio:copy_draft',
  'presence_studio:email_triage_hint',
  'presence_studio:email_reply_label',
  'presence_studio:email_auth_checking',
  'presence_studio:account_auto',
  'presence_studio:recipient_placeholder',
  'presence_studio:subject_placeholder',
  'presence_studio:tone_clear',
  'presence_studio:tone_warm',
  'presence_studio:tone_firm',
  'presence_studio:reply_message_id_placeholder',
  'presence_studio:mode_new',
  'presence_studio:mode_reply',
  'presence_studio:mode_reply_all',
  'presence_studio:email_draft_empty',
  'presence_studio:create_reply_draft',
  'presence_studio:create_account_draft',
  'presence_studio:send_approved_email',
  'presence_studio:refresh_auth',
  'presence_studio:reload_draft',
  'presence_studio:copy_reply',
  'presence_studio:email_draft_hint',
  'presence_studio:approval_label',
  'presence_studio:outcomes_label',
  'presence_studio:requested_work_label',
  'presence_studio:browser_label',
  'presence_studio:prepare_browser',
  'presence_studio:browser_task_hint',
  'presence_studio:recording_started',
  'presence_studio:recording_stopping',
  'presence_studio:minutes_created',
  'presence_studio:recording_short',
  // UI-01d (index.html i18n hardcoding cleanup): keys the `/work` page's
  // inline script resolves via `uiTextKey`/`uiMessage` for its dynamic
  // panels (memory detail, approvals, OS control plane, outcomes, voice
  // subtitles, task sessions, minutes recording status).
  'presence_studio:missing_inputs_none',
  'presence_studio:label_next_action',
  'presence_studio:loading_memory',
  'presence_studio:open_raw_memory',
  'presence_studio:select_memory_hint',
  'presence_studio:no_summary_yet',
  'presence_studio:no_detail',
  'presence_studio:no_approvals_waiting',
  'presence_studio:approvals_hint',
  'presence_studio:apply_failed_hint',
  'presence_studio:no_os_actions_waiting',
  'presence_studio:decision_recorded',
  'presence_studio:confirm_apply_action',
  'presence_studio:action_applied',
  'presence_studio:no_recent_outcomes',
  'presence_studio:outcomes_hint',
  'presence_studio:download_artifact',
  'presence_studio:voice_responding_subtitle',
  'presence_studio:voice_listening_subtitle',
  'presence_studio:voice_planning_subtitle',
  'presence_studio:voice_processing_subtitle',
  'presence_studio:voice_operator_ready_subtitle',
  'presence_studio:voice_handsfree_conversation_work_subtitle',
  'presence_studio:voice_handsfree_conversation_subtitle',
  'presence_studio:voice_handsfree_mode_subtitle',
  'presence_studio:candidate_index_spoken',
  'presence_studio:no_requested_work',
  'presence_studio:requested_work_hint',
  'presence_studio:select_work_item_hint',
  'presence_studio:no_explicit_outcomes',
  'presence_studio:no_result_preview',
  'presence_studio:authority_approval_required_short',
  'presence_studio:authority_auto_proceed_short',
  'presence_studio:recording_in_progress_hint',
  'presence_studio:recording_start_failed',
  'presence_studio:minutes_generation_failed',
  'tui:tui_cockpit_authority_autonomous',
  'tui:tui_cockpit_authority_approval',
  'tui:tui_cockpit_authority_clarification',
  'tui:tui_cockpit_outcome_answer',
  'tui:tui_cockpit_outcome_artifact',
  'tui:tui_cockpit_outcome_approval_ready_plan',
  'tui:tui_cockpit_outcome_service_change',
  'tui:tui_cockpit_outcome_status_report',
] as const satisfies readonly VocabularyKey[];

// FD-02: exactly the keys `static/home.js` renders (UI-06 adds the
// `presence_studio` next-action / metric labels). Mirrors
// `PRESENCE_STUDIO_VOCABULARY_KEYS` above / `/api/ui-vocabulary` — see
// `GET /api/home-vocabulary` in `front-desk-routes.ts`.
export const HOME_VOCABULARY_KEYS = [
  'front_desk:home_briefing',
  'front_desk:home_briefing_clear',
  'front_desk:home_recommend',
  'front_desk:home_ask_placeholder',
  'front_desk:home_ask_send',
  'front_desk:home_ask_voice',
  'front_desk:chip_email',
  'front_desk:chip_minutes',
  'front_desk:chip_browser',
  'front_desk:chip_webapp',
  'front_desk:home_decide_title',
  'front_desk:home_decide_more',
  'front_desk:home_decide_empty',
  'front_desk:home_progress_title',
  'front_desk:home_progress_more',
  'front_desk:home_progress_empty',
  'front_desk:home_progress_summary',
  'front_desk:count_items',
  'front_desk:tag_approval',
  'front_desk:tag_exception',
  'front_desk:tag_stalled',
  'front_desk:tag_memory',
  'front_desk:tag_in_progress',
  'front_desk:tag_delivered',
  'front_desk:action_receive',
  'front_desk:progress_delivered_title',
  'presence_studio:home_next_ask',
  'presence_studio:home_metric_decide',
] as const satisfies readonly VocabularyKey[];

// FD-05: exactly the `front_desk` keys `static/progress.js` renders. Mirrors
// `HOME_VOCABULARY_KEYS` above — see `GET /api/progress-vocabulary` in
// `front-desk-routes.ts`.
export const PROGRESS_VOCABULARY_KEYS = [
  'front_desk:progress_filter_active',
  'front_desk:progress_filter_delivered',
  'front_desk:progress_filter_done',
  'front_desk:progress_delivered_title',
  'front_desk:progress_delivered_waiting',
  'front_desk:progress_empty_active',
  'front_desk:progress_empty_delivered',
  'front_desk:progress_select_hint',
  'front_desk:progress_detail_requested',
  'front_desk:progress_detail_now',
  'front_desk:progress_detail_next',
  'front_desk:progress_detail_log',
  'front_desk:progress_action_note',
  'front_desk:progress_open_mirror',
  // The prefilled "ask about this item" text (word order is per locale).
  'front_desk:progress_ask_about',
  'front_desk:action_open',
  'front_desk:action_receive',
  'front_desk:action_revise',
  'front_desk:count_items',
  // UI-06: row status pill labels.
  'front_desk:tag_in_progress',
  'front_desk:tag_delivered',
] as const satisfies readonly VocabularyKey[];

// FD-03: exactly the keys `static/ask.js` renders. Mirrors
// `HOME_VOCABULARY_KEYS` / `PROGRESS_VOCABULARY_KEYS` above — see
// `GET /api/ask-vocabulary` in `front-desk-routes.ts`. Mixes the `front_desk`
// domain with the shared `tui` authority/outcome labels (same mix
// `PRESENCE_STUDIO_VOCABULARY_KEYS` above already uses for `index.html`'s own
// intent-resolution rendering).
export const ASK_VOCABULARY_KEYS = [
  'front_desk:home_ask_placeholder',
  'front_desk:home_ask_send',
  'front_desk:home_ask_voice',
  'front_desk:ask_placeholder_followup',
  'front_desk:ask_about_title',
  'front_desk:ask_understood',
  'front_desk:ask_state',
  'front_desk:ask_decision_point',
  'front_desk:ask_deliverable',
  'front_desk:ask_recent',
  'front_desk:ask_handsfree_on',
  'front_desk:ask_handsfree_off',
  'front_desk:ask_listening',
  'front_desk:ask_thinking',
  'front_desk:ask_proceed',
  'front_desk:ask_more_detail',
  'front_desk:ask_empty',
  'front_desk:ask_today',
  'front_desk:ask_voice_settings',
  'front_desk:ask_send_failed',
  'front_desk:chip_email',
  'front_desk:chip_minutes',
  'front_desk:chip_browser',
  'front_desk:chip_webapp',
  'front_desk:count_items',
  // FD-09: `resolution_shape` labels for the "Current state" block —
  // `front_desk`-domain plain wording (see `ASK_SHAPE_LABEL_KEY` in
  // `ask-view.ts` for why this does not reuse the existing
  // `tui:tui_cockpit_shape_*` keys).
  'front_desk:shape_direct_answer',
  'front_desk:shape_task_session',
  'front_desk:shape_mission',
  'front_desk:shape_project_bootstrap',
  // FD-09: the UX-contract conversation-turn shape chip (`AskConversationShape`
  // in `ask-view.ts`), rendered through vocabulary instead of the raw
  // internal shape id.
  'front_desk:shape_chip_clarification',
  'front_desk:shape_chip_execution_preview',
  'front_desk:shape_chip_status_summary',
  'front_desk:shape_chip_delivery_summary',
  'front_desk:shape_chip_reply',
  'tui:tui_cockpit_authority_autonomous',
  'tui:tui_cockpit_authority_approval',
  'tui:tui_cockpit_authority_clarification',
  'tui:tui_cockpit_outcome_answer',
  'tui:tui_cockpit_outcome_artifact',
  'tui:tui_cockpit_outcome_approval_ready_plan',
  'tui:tui_cockpit_outcome_service_change',
  'tui:tui_cockpit_outcome_status_report',
  // HT-06: the `/ask?mode=hearing` card (`hearing-card` in `ask.html`) —
  // requirement labels themselves come from the hearing record's own
  // per-locale `label` (resolved server-side from `label_key`), never from
  // this fixed-chrome list.
  'front_desk:hearing_title',
  'front_desk:hearing_coverage',
  'front_desk:hearing_decide',
  'front_desk:hearing_pending',
  'front_desk:hearing_canvas_frame_title',
  // HT-02: one-line canvas generation status under the `#hearing-canvas`
  // iframe, driven by the hearing record's `canvas_generation` field
  // (`'pending' | 'generated' | 'template'`, absent on old records treated
  // as `template`).
  'front_desk:hearing_canvas_updating',
  'front_desk:hearing_canvas_generated',
  'front_desk:hearing_canvas_template',
  // HT-03 (2nd half): the "confirm and hand off as a request" action on the
  // decided hearing card, and its result — `POST /api/hearing/:session/handoff`.
  'front_desk:hearing_handoff_button',
  'front_desk:hearing_handoff_pending',
  'front_desk:hearing_handoff_done',
  'front_desk:hearing_handoff_failed',
  'front_desk:hearing_mission_label',
  'front_desk:hearing_open_decide',
  // WI-08: the "save to the work inventory" confirm action for the
  // `work_inventory` hearing scenario (`handoff: 'work_inventory'` in
  // `hearing-scenarios.json`) — mirrors the `hearing_handoff_*`/
  // `hearing_open_decide` set above, which is the equivalent for the
  // `mission` handoff. The scenario's own requirement labels are resolved
  // server-side into each `record.requirements[].label` (same mechanism as
  // `web_app_build`'s `hearing_req_*` keys, also absent from this list) and
  // rendered inside the canvas iframe, never read by this client script
  // directly.
  'front_desk:hearing_inventory_button',
  'front_desk:hearing_inventory_pending',
  'front_desk:hearing_inventory_done',
  'front_desk:hearing_inventory_failed',
  'front_desk:hearing_inventory_entry_label',
  'front_desk:hearing_inventory_open',
] as const satisfies readonly VocabularyKey[];

// HT-06: exactly the `front_desk` keys `static/help.js` renders for the
// training block (`#training-content`) — the track/lesson catalog data
// itself (titles, goals, checks) stays free-form catalog content from
// `GET /api/training/catalog`; only this fixed UI chrome is vocabulary.
// Mirrors `ASK_VOCABULARY_KEYS` above — see `GET /api/help-vocabulary` in
// `front-desk-routes.ts`.
export const HELP_VOCABULARY_KEYS = [
  'front_desk:training_choose_track',
  'front_desk:training_open',
  'front_desk:training_back',
  'front_desk:training_try',
  'front_desk:training_done_prefix',
  'front_desk:training_level_beginner',
  'front_desk:training_level_intermediate',
  'front_desk:training_level_advanced',
  'front_desk:training_status_not_started',
  'front_desk:training_status_in_progress',
  'front_desk:training_status_complete',
] as const satisfies readonly VocabularyKey[];

// UI-05/UI-06 (SURFACE_UI_UNIFICATION_PLAN_2026-09-23 §3.1): front-desk pages
// are served as small templates so their fixed chrome (page title, headings,
// input placeholders, loading text) is already in the viewer's language at
// first paint — the page never shows empty, unlabeled boxes while its script
// fetches the vocabulary. `{{t:<domain>:<key>}}` is replaced with the
// catalog text (HTML-escaped) and `{{locale}}` with the resolved locale; the
// page scripts still re-render everything from the vocabulary routes.
// `{{partial:<name>}}` inlines one of the fixed shared shell fragments below
// (rail placeholder, header controls) so the five pages do not each copy them.

/** Cookie the front-desk shell mirrors its stored language choice into. */
export const FRONT_DESK_LOCALE_COOKIE = 'kb-ui-locale';
export type FrontDeskPageLocale = 'en' | 'ja';

/** Shared shell fragments (`static/<file>`), addressable only by these names. */
export const FRONT_DESK_PAGE_PARTIALS: Readonly<Record<string, string>> = Object.freeze({
  rail: 'front-desk-rail.partial.html',
  'shell-controls': 'front-desk-shell-controls.partial.html',
});

const PARTIAL_PATTERN = /\{\{partial:([a-z-]+)\}\}/g;
const TEMPLATE_KEY_PATTERN = /\{\{t:([a-z0-9_]+:[a-z0-9_]+)\}\}/g;

function escapeTemplateText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The page language: the shell's `kb-ui-locale` cookie when it names a
 * supported front-desk locale, else the first `Accept-Language` tag that is
 * one, else English.
 */
export function resolveFrontDeskPageLocale(headers: {
  cookie?: string | string[];
  'accept-language'?: string | string[];
}): FrontDeskPageLocale {
  const cookie = Array.isArray(headers.cookie) ? headers.cookie.join(';') : headers.cookie || '';
  const match = /(?:^|;)\s*kb-ui-locale=(en|ja)\s*(?:;|$)/.exec(cookie);
  if (match) return match[1] as FrontDeskPageLocale;
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

/** Fill a front-desk page template for `locale` (pure; exported for tests). */
export function renderFrontDeskPageTemplate(
  html: string,
  locale: FrontDeskPageLocale,
  loadPartial: (file: string) => string = () => ''
): string {
  return html
    .replace(PARTIAL_PATTERN, (_match, name: string) =>
      Object.prototype.hasOwnProperty.call(FRONT_DESK_PAGE_PARTIALS, name)
        ? loadPartial(FRONT_DESK_PAGE_PARTIALS[name])
        : ''
    )
    .replace(/\{\{locale\}\}/g, locale)
    .replace(TEMPLATE_KEY_PATTERN, (_match, key: string) =>
      escapeTemplateText(catalogT(key as VocabularyKey, undefined, locale))
    );
}

function sendFrontDeskPage(
  req: express.Request,
  res: express.Response,
  staticDir: string,
  file: string
): void {
  const locale = resolveFrontDeskPageLocale(req.headers);
  const read = (name: string) =>
    String(safeReadFile(path.join(staticDir, name), { encoding: 'utf8' }) || '');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Language', locale);
  res.type('html').send(renderFrontDeskPageTemplate(read(file), locale, read));
}

/**
 * The page templates are also files in `static/`, so `express.static` would
 * serve `/home.html` etc. raw — `{{t:…}}` placeholders and all. Those paths
 * redirect to their canonical routes (query string kept), and the shared
 * shell partials are never served on their own.
 */
export const FRONT_DESK_TEMPLATE_FILE_REDIRECTS: Readonly<Record<string, string>> = Object.freeze({
  '/home.html': '/',
  '/index.html': '/work',
  '/ask.html': '/ask',
  '/progress.html': '/progress',
  '/help.html': '/help',
});

/** Canonical route for a raw template file request, keeping the query string; null otherwise. */
export function frontDeskTemplateRedirect(originalUrl: string): string | null {
  const queryIndex = originalUrl.indexOf('?');
  const pathname = queryIndex === -1 ? originalUrl : originalUrl.slice(0, queryIndex);
  const target = Object.prototype.hasOwnProperty.call(FRONT_DESK_TEMPLATE_FILE_REDIRECTS, pathname)
    ? FRONT_DESK_TEMPLATE_FILE_REDIRECTS[pathname]
    : null;
  if (!target) return null;
  return queryIndex === -1 ? target : `${target}${originalUrl.slice(queryIndex)}`;
}

// FD-02: `/` is now the human home page; the pre-FD-02 workbench moved to
// `/work` unchanged. Both must be registered ahead of `express.static` (the
// caller does this) so its default `index: 'index.html'` behavior for
// `GET /` never wins the race against `home.html`.
export function registerFrontDeskHomeWorkPages(app: express.Express, staticDir: string): void {
  // Registered ahead of `express.static` (see above) so a raw template file
  // never reaches the browser unrendered.
  for (const file of Object.keys(FRONT_DESK_TEMPLATE_FILE_REDIRECTS)) {
    app.get(file, (req, res) => {
      res.redirect(302, frontDeskTemplateRedirect(req.originalUrl || file) || '/');
    });
  }
  for (const partial of Object.values(FRONT_DESK_PAGE_PARTIALS)) {
    app.get(`/${partial}`, (_req, res) => {
      res.status(404).type('text').send('Not found');
    });
  }

  app.get('/', (req, res) => {
    sendFrontDeskPage(req, res, staticDir, 'home.html');
  });

  app.get('/work', (req, res) => {
    sendFrontDeskPage(req, res, staticDir, 'index.html');
  });
}

// FD-06/03/05/08: the remaining front-desk page routes, registered after
// `express.static` (a literal `/onboarding`, `/ask`, `/progress`, or `/help`
// path only matches a static file named exactly that, with no extension, so
// `express.static` never intercepts them).
export function registerFrontDeskAuxPages(app: express.Express, staticDir: string): void {
  // FD-06: the setup wizard is folded into the concierge 設定 page; the
  // concierge port comes from the surface manifest (never a literal). FD-08
  // deleted the static onboarding.html/.css/.js — this redirect is now the
  // entire route.
  app.get('/onboarding', (_req, res) => {
    res.redirect(302, `http://127.0.0.1:${readFrontDeskSurfacePorts().concierge}/settings`);
  });

  // FD-03: the dedicated "頼む" page, replacing the interim `/work` redirect.
  app.get('/ask', (req, res) => {
    sendFrontDeskPage(req, res, staticDir, 'ask.html');
  });

  // FD-05: the dedicated "進み具合" page, replacing the interim `/work`
  // redirect.
  app.get('/progress', (req, res) => {
    sendFrontDeskPage(req, res, staticDir, 'progress.html');
  });

  // FD-08: the dedicated "使い方を見る" page (旧 /learn), replacing the interim
  // `/onboarding` redirect.
  app.get('/help', (req, res) => {
    sendFrontDeskPage(req, res, staticDir, 'help.html');
  });

  // HT-05: a single training track's page — same static file as `/help`;
  // `static/help.js` reads the track id from `window.location.pathname` and
  // renders the matching catalog track client-side (GET /api/training/catalog).
  app.get('/help/:track', (req, res) => {
    sendFrontDeskPage(req, res, staticDir, 'help.html');
  });
}
