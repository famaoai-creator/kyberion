/**
 * page.ts — personal-workbench page on the shared A2UI kit (PA-06).
 *
 * The server renders the shell (header, layout hosts, bootstrap); the
 * browser module `workbench-client.js` renders the capture card, the saved
 * entries, the calendar propose → confirm → apply flow and the other
 * governed actions with the `kyberion-base` catalog. Every user-visible
 * string comes from the `personal_workbench` vocabulary for the request's
 * locale.
 */
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import type { SupportedLocale } from '@agent/core/locale-normalize';
import type { VocabularyKey } from '@agent/core/t';
import { padT, renderPadHeader, renderPadPage } from '../lib/pad-ui.js';

export interface PersonalWorkbenchPageConfig {
  token: string;
  outLabel: string;
  locale: SupportedLocale;
}

export const PERSONAL_WORKBENCH_CLIENT_SCRIPT = 'scripts/personal-workbench/workbench-client.js';

/** CLI approval hint shown before the first proposal (a command, not prose). */
export const PERSONAL_WORKBENCH_APPROVE_COMMAND = 'pnpm kyberion approve <id> personal-workbench';

/** Vocabulary the browser module reads through `t(key)`. */
export const PERSONAL_WORKBENCH_TEXT_KEYS = [
  'personal_workbench:capture_title',
  'personal_workbench:kind',
  'personal_workbench:kind_link',
  'personal_workbench:kind_task',
  'personal_workbench:kind_follow_up',
  'personal_workbench:kind_decision',
  'personal_workbench:kind_expense',
  'personal_workbench:kind_daily_review',
  'personal_workbench:entry_title',
  'personal_workbench:entry_body',
  'personal_workbench:metadata',
  'personal_workbench:metadata_placeholder',
  'personal_workbench:save',
  'personal_workbench:saving',
  'personal_workbench:saved',
  'personal_workbench:save_failed',
  'personal_workbench:metadata_invalid',
  'personal_workbench:out_path',
  'personal_workbench:saved_title',
  'personal_workbench:load',
  'personal_workbench:entries_empty',
  'personal_workbench:entries_not_loaded',
  'personal_workbench:entries_not_loaded_body',
  'personal_workbench:loading',
  'personal_workbench:loaded',
  'personal_workbench:load_failed',
  'personal_workbench:entry_meta',
  'personal_workbench:status_proposed',
  'personal_workbench:calendar_title',
  'personal_workbench:cal_summary',
  'personal_workbench:cal_summary_placeholder',
  'personal_workbench:cal_start',
  'personal_workbench:cal_start_placeholder',
  'personal_workbench:cal_end',
  'personal_workbench:cal_end_placeholder',
  'personal_workbench:cal_description',
  'personal_workbench:cal_propose',
  'personal_workbench:cal_confirm',
  'personal_workbench:cal_apply',
  'personal_workbench:cal_approval_id',
  'personal_workbench:cal_approval_placeholder',
  'personal_workbench:cal_initial',
  'personal_workbench:cal_proposing',
  'personal_workbench:cal_proposed',
  'personal_workbench:cal_propose_failed',
  'personal_workbench:cal_need_id',
  'personal_workbench:cal_need_confirm',
  'personal_workbench:cal_applying',
  'personal_workbench:cal_applied',
  'personal_workbench:cal_apply_failed',
  'personal_workbench:cal_latest',
  'personal_workbench:actions_title',
  'personal_workbench:action',
  'personal_workbench:action_ocr',
  'personal_workbench:action_knowledge',
  'personal_workbench:action_email',
  'personal_workbench:action_payload',
  'personal_workbench:action_payload_placeholder',
  'personal_workbench:run_action',
  'personal_workbench:actions_hint',
  'personal_workbench:running',
  'personal_workbench:action_done',
  'personal_workbench:action_failed',
  'personal_workbench:payload_invalid',
  'personal_workbench:result_title',
] as const satisfies readonly VocabularyKey[];

const BODY_HTML = [
  '<div class="kb-stack" data-gap="lg">',
  '<div class="kb-grid" data-gap="lg" data-min-column-width="lg">',
  '<div class="kb-stack" data-gap="md">',
  '<div id="pw-capture"></div>',
  '<div id="pw-capture-status"></div>',
  '</div>',
  '<div id="pw-entries"></div>',
  '</div>',
  '<div class="kb-stack" data-gap="md">',
  '<div id="pw-calendar"></div>',
  '<div id="pw-calendar-status"></div>',
  '</div>',
  '<div class="kb-stack" data-gap="md">',
  '<div id="pw-actions"></div>',
  '<div id="pw-action-result"></div>',
  '</div>',
  '</div>',
].join('');

function clientScript(): string {
  return String(
    safeReadFile(pathResolver.rootResolve(PERSONAL_WORKBENCH_CLIENT_SCRIPT), { encoding: 'utf8' })
  );
}

export function personalWorkbenchPageHtml(config: PersonalWorkbenchPageConfig): string {
  const t = padT(config.locale);
  const title = t('personal_workbench:title');
  return renderPadPage({
    locale: config.locale,
    title,
    role: 'personal-workbench',
    bodyHtml:
      renderPadHeader({
        locale: config.locale,
        title,
        subtitle: t('personal_workbench:subtitle'),
      }) + BODY_HTML,
    scriptModule: clientScript(),
    textKeys: PERSONAL_WORKBENCH_TEXT_KEYS,
    bootstrap: {
      token: config.token,
      outLabel: config.outLabel,
      approveCommand: PERSONAL_WORKBENCH_APPROVE_COMMAND,
    },
  });
}
