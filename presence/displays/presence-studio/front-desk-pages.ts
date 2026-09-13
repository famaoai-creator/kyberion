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
import { readFrontDeskSurfacePorts } from '@agent/core/front-desk-nav';
import { type VocabularyKey } from '@agent/core/t';

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
  'tui:tui_cockpit_authority_autonomous',
  'tui:tui_cockpit_authority_approval',
  'tui:tui_cockpit_authority_clarification',
  'tui:tui_cockpit_outcome_answer',
  'tui:tui_cockpit_outcome_artifact',
  'tui:tui_cockpit_outcome_approval_ready_plan',
  'tui:tui_cockpit_outcome_service_change',
  'tui:tui_cockpit_outcome_status_report',
] as const satisfies readonly VocabularyKey[];

// FD-02: exactly the `front_desk` keys `static/home.js` renders. Mirrors
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
  'front_desk:action_open',
  'front_desk:action_receive',
  'front_desk:action_revise',
  'front_desk:count_items',
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
] as const satisfies readonly VocabularyKey[];

// FD-02: `/` is now the human home page; the pre-FD-02 workbench moved to
// `/work` unchanged. Both must be registered ahead of `express.static` (the
// caller does this) so its default `index: 'index.html'` behavior for
// `GET /` never wins the race against `home.html`.
export function registerFrontDeskHomeWorkPages(app: express.Express, staticDir: string): void {
  app.get('/', (_req, res) => {
    res.sendFile(path.join(staticDir, 'home.html'));
  });

  app.get('/work', (_req, res) => {
    res.sendFile(path.join(staticDir, 'index.html'));
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
  app.get('/ask', (_req, res) => {
    res.sendFile(path.join(staticDir, 'ask.html'));
  });

  // FD-05: the dedicated "進み具合" page, replacing the interim `/work`
  // redirect.
  app.get('/progress', (_req, res) => {
    res.sendFile(path.join(staticDir, 'progress.html'));
  });

  // FD-08: the dedicated "使い方を見る" page (旧 /learn), replacing the interim
  // `/onboarding` redirect.
  app.get('/help', (_req, res) => {
    res.sendFile(path.join(staticDir, 'help.html'));
  });

  // HT-05: a single training track's page — same static file as `/help`;
  // `static/help.js` reads the track id from `window.location.pathname` and
  // renders the matching catalog track client-side (GET /api/training/catalog).
  app.get('/help/:track', (_req, res) => {
    res.sendFile(path.join(staticDir, 'help.html'));
  });
}
