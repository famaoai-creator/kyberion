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
import { readFrontDeskSurfaceUrls } from '@agent/core/front-desk-nav';
import { t as catalogT, type VocabularyKey } from '@agent/core/t';

export const ENGINE_CONFIG_VOCABULARY_KEYS = [
  'presence_studio:engine_config_title',
  'presence_studio:engine_config_description',
  'presence_studio:engine_config_back',
  'presence_studio:engine_config_profile',
  'presence_studio:engine_config_profile_unknown',
  'presence_studio:engine_config_profile_personal',
  'presence_studio:engine_config_profile_customer',
  'presence_studio:engine_config_fields',
  'presence_studio:engine_config_clear_help',
  'presence_studio:engine_config_save',
  'presence_studio:engine_config_reload',
  'presence_studio:engine_config_loading',
  'presence_studio:engine_config_ready',
  'presence_studio:engine_config_saving',
  'presence_studio:engine_config_saved',
  'presence_studio:engine_config_unchanged',
  'presence_studio:engine_config_load_failed',
  'presence_studio:engine_config_save_failed',
  'presence_studio:engine_config_denied',
  'presence_studio:engine_config_conflict',
  'presence_studio:engine_config_invalid',
  'presence_studio:engine_config_ffmpeg_bin',
  'presence_studio:engine_config_ffprobe_bin',
  'presence_studio:engine_config_python_bin',
  'presence_studio:engine_config_audio_record_command',
  'presence_studio:engine_config_audio_playback_backend',
  'presence_studio:engine_config_fluid_audio_stt_command',
  'presence_studio:engine_config_streaming_stt_bridge',
  'presence_studio:engine_config_streaming_tts_bridge',
  'presence_studio:engine_config_agent_runtime_backend',
  'presence_studio:engine_config_agent_pane_runtime_provider',
  'presence_studio:engine_config_mode_default',
  'presence_studio:engine_config_mode_pipe',
  'presence_studio:engine_config_mode_pane',
  'presence_studio:engine_config_binary_help',
  'presence_studio:engine_config_record_help',
  'presence_studio:engine_config_fluid_help',
  'presence_studio:engine_config_bridge_help',
] as const satisfies readonly VocabularyKey[];

export const PRESENCE_STUDIO_VOCABULARY_KEYS = [
  ...ENGINE_CONFIG_VOCABULARY_KEYS,
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
  'presence_studio:label_reuse_proposal',
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
  'front_desk:work_home_decision_scope_unavailable',
  'front_desk:work_home_version_unknown',
  'front_desk:work_home_refresh',
  'front_desk:work_home_detail_mode',
  'front_desk:work_home_quiet',
  'front_desk:work_home_detailed',
  'front_desk:work_home_attention_title',
  'front_desk:work_home_all_title',
  'front_desk:work_home_verified_title',
  'front_desk:work_home_overview',
  'front_desk:work_home_partial',
  'front_desk:work_home_coverage_note',
  'front_desk:work_home_resume_readonly',
  'front_desk:work_home_request_unavailable',
  'front_desk:work_home_resume_context',
  'front_desk:work_home_source',
  'front_desk:work_home_last_recorded',
  'front_desk:work_home_last_verified',
  'front_desk:work_home_not_verified',
  'front_desk:work_home_time_unknown',
  'front_desk:work_home_unknown',
  'front_desk:work_home_revision',
  'front_desk:work_home_version_state',
  'front_desk:work_home_change_reason',
  'front_desk:work_home_format_change',
  'front_desk:work_home_grouped_updates',
  'front_desk:work_home_attention_empty',
  'front_desk:work_home_attention_unknown',
  'front_desk:work_home_work_empty',
  'front_desk:work_home_work_unknown',
  'front_desk:work_home_load_failed',
  'front_desk:work_home_source_conversation',
  'front_desk:work_home_source_approval',
  'front_desk:work_home_source_approvals',
  'front_desk:work_home_source_held_action',
  'front_desk:work_home_source_held_actions',
  'front_desk:work_home_source_task_session',
  'front_desk:work_home_source_task_sessions',
  'front_desk:work_home_source_artifact',
  'front_desk:work_home_source_artifacts',
  'front_desk:work_home_source_state_partial',
  'front_desk:work_home_source_state_unavailable',
  'front_desk:work_home_link_conversation',
  'front_desk:work_home_link_progress',
  'front_desk:work_home_link_artifact',
  'front_desk:work_home_link_approval',
  'front_desk:work_home_link_held_action',
  'front_desk:work_home_version_latest_verified',
  'front_desk:work_home_version_older_verified',
  'front_desk:work_home_version_requested_pending',
  'front_desk:work_home_version_requested_unknown',
  'front_desk:work_home_status_recorded',
  'front_desk:work_home_status_intake',
  'front_desk:work_home_status_queued',
  'front_desk:work_home_status_awaiting_input',
  'front_desk:work_home_status_awaiting_approval',
  'front_desk:work_home_status_running',
  'front_desk:work_home_status_verifying',
  'front_desk:work_home_status_blocked',
  'front_desk:work_home_status_unknown',
  'front_desk:work_home_status_answered',
  'front_desk:work_home_status_work_completed',
  'front_desk:work_home_status_completion_unverified',
  'front_desk:work_home_status_failed',
  'front_desk:work_home_status_released',
  'front_desk:work_home_status_artifact_recorded',
  'front_desk:work_home_status_cancel_requested',
  'front_desk:work_home_next_provide_input',
  'front_desk:work_home_next_review_approval',
  'front_desk:work_home_next_review_held_action',
  'front_desk:work_home_next_review_blocker',
  'front_desk:work_home_next_inspect_status',
  'front_desk:work_home_next_arrange_execution',
  'front_desk:work_home_next_follow_progress',
  'front_desk:work_home_next_verify_result',
  'front_desk:work_home_next_review_result',
  'front_desk:work_home_next_open_artifact',
  'front_desk:work_home_next_resume_conversation',
  'front_desk:work_home_unknown_recorded_time_unknown',
  'front_desk:work_home_unknown_verification_unknown',
  'front_desk:work_home_unknown_completion_not_verified',
  'front_desk:work_home_unknown_execution_state_unknown',
  'front_desk:work_home_unknown_version_unknown',
  'front_desk:work_home_unknown_artifact_time_unknown',
  'front_desk:work_home_unknown_source_unavailable',
  'front_desk:work_home_unknown_source_partial',
  'front_desk:progress_phase_estimate',
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

// FD-03: exactly the keys `static/ask.js` renders — shared with Concierge's
// `GET /api/ask-vocabulary` in `@agent/core/surface/ask-view`.
export { ASK_VOCABULARY_KEYS } from '@agent/core/surface/ask-view';

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
  '/home.html': '/home',
  '/index.html': '/work',
  '/ask.html': '/ask',
  // Retired page (now Concierge 仕事 › 依頼): old bookmarks follow /progress's redirect.
  '/progress.html': '/progress',
  // Retired page (now Concierge 使い方): old bookmarks follow /help's redirect.
  '/help.html': '/help',
  // Retired page (now Concierge 初めての仕事): old bookmarks follow /first-job's redirect.
  '/first-job.html': '/first-job',
  '/live-avatar.html': '/live-avatar',
  '/engine-config.html': '/engine-config',
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

/** Decoded, lower-cased request path for template matching; null when undecodable. */
export function normalizeTemplateRequestPath(requestPath: string): string | null {
  try {
    return decodeURIComponent(requestPath).toLowerCase();
  } catch {
    return null;
  }
}

// FD-02: `/` is now the human home page; the pre-FD-02 workbench moved to
// `/work` unchanged. Both must be registered ahead of `express.static` (the
// caller does this) so its default `index: 'index.html'` behavior for
// `GET /` never wins the race against `home.html`.
export function registerFrontDeskHomeWorkPages(app: express.Express, staticDir: string): void {
  // Registered ahead of `express.static` (see above) so a raw template file
  // never reaches the browser unrendered. Matching uses the decoded,
  // case-folded path because `express.static` decodes too
  // (`/home%2Ehtml`, `/HOME.html` must not bypass this guard).
  const partialPaths = new Set(
    Object.values(FRONT_DESK_PAGE_PARTIALS).map((partial) => `/${partial}`.toLowerCase())
  );
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const pathname = normalizeTemplateRequestPath(req.path);
    if (pathname === null) return next();
    if (Object.prototype.hasOwnProperty.call(FRONT_DESK_TEMPLATE_FILE_REDIRECTS, pathname)) {
      const queryIndex = req.originalUrl.indexOf('?');
      const query = queryIndex === -1 ? '' : req.originalUrl.slice(queryIndex);
      res.redirect(302, `${FRONT_DESK_TEMPLATE_FILE_REDIRECTS[pathname]}${query}`);
      return;
    }
    if (partialPaths.has(pathname)) {
      res.status(404).type('text').send('Not found');
      return;
    }
    next();
  });

  // Unified shell: the workspace overview lives on Concierge (`/w`), so the
  // studio root hands the person to it instead of a second, partial home.
  // The studio home page stays reachable at `/home`.
  app.get('/', (req, res) => {
    const queryIndex = req.originalUrl.indexOf('?');
    const query = queryIndex === -1 ? '' : req.originalUrl.slice(queryIndex);
    res.redirect(302, readFrontDeskSurfaceUrls().concierge + '/w' + query);
  });
  app.get('/home', (req, res) => {
    sendFrontDeskPage(req, res, staticDir, 'home.html');
  });

  app.get('/work', (req, res) => {
    sendFrontDeskPage(req, res, staticDir, 'index.html');
  });
  app.get('/engine-config', (req, res) => {
    sendFrontDeskPage(req, res, staticDir, 'engine-config.html');
  });
  app.get('/live-avatar', (req, res) => {
    sendFrontDeskPage(req, res, staticDir, 'live-avatar.html');
  });
}

/** Concierge 仕事 › 依頼 with an old `/progress` query kept (its own `tab` wins). */
export function conciergeRequestsPath(query: string): string {
  const params = new URLSearchParams(query);
  params.delete('tab');
  const rest = params.toString();
  return '/work?tab=requests' + (rest ? '&' + rest : '');
}

// FD-06/03/05/08: the remaining front-desk page routes, registered after
// `express.static` (a literal `/onboarding`, `/ask`, `/progress`, or `/help`
// path only matches a static file named exactly that, with no extension, so
// `express.static` never intercepts them).
export function registerFrontDeskAuxPages(app: express.Express, staticDir: string): void {
  // 初めての仕事 is served by Concierge (Kyberion server phase 2); the old
  // address hands the person there, query string kept.
  app.get('/first-job', (req, res) => {
    const queryIndex = req.originalUrl.indexOf('?');
    const query = queryIndex === -1 ? '' : req.originalUrl.slice(queryIndex);
    res.redirect(302, readFrontDeskSurfaceUrls().concierge + '/first-job' + query);
  });

  // FD-06: the setup wizard is folded into the concierge 設定 page; the
  // concierge port comes from the surface manifest (never a literal). FD-08
  // deleted the static onboarding.html/.css/.js — this redirect is now the
  // entire route.
  app.get('/onboarding', (req, res) => {
    const tenant = typeof req.query.tenant === 'string' ? req.query.tenant : undefined;
    const suffix = tenant ? '?tenant=' + encodeURIComponent(tenant) : '';
    res.redirect(302, readFrontDeskSurfaceUrls().concierge + '/settings' + suffix);
  });

  // FD-03: the dedicated "頼む" page, replacing the interim `/work` redirect.
  app.get('/ask', (req, res) => {
    sendFrontDeskPage(req, res, staticDir, 'ask.html');
  });

  // 進み具合 is served by Concierge as 仕事 › 依頼 (`/work?tab=requests`,
  // Kyberion server phase 2). The old address hands the person there with its
  // query kept (`request`, `tenant`, …); the fragment (`#<id>`) follows the
  // redirect in the browser.
  app.get('/progress', (req, res) => {
    const queryIndex = req.originalUrl.indexOf('?');
    res.redirect(
      302,
      readFrontDeskSurfaceUrls().concierge +
        conciergeRequestsPath(queryIndex === -1 ? '' : req.originalUrl.slice(queryIndex + 1))
    );
  });

  // 使い方 (`/help`, `/help/<track>`) is served by Concierge (Kyberion server
  // phase 2); the old addresses hand the person there, query string kept.
  const toConciergeHelp = (pathname: string, req: express.Request, res: express.Response) => {
    const queryIndex = req.originalUrl.indexOf('?');
    const query = queryIndex === -1 ? '' : req.originalUrl.slice(queryIndex);
    res.redirect(302, readFrontDeskSurfaceUrls().concierge + pathname + query);
  };
  app.get('/help', (req, res) => toConciergeHelp('/help', req, res));
  app.get('/help/:track', (req, res) =>
    toConciergeHelp(`/help/${encodeURIComponent(String(req.params.track))}`, req, res)
  );
}
