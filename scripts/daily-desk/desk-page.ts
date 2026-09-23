/**
 * desk-page.ts — daily desk page on the shared A2UI kit (PA-06).
 *
 * Three panels (Journal / TODO / NOW) + instruction + local draft + handoff.
 * The server renders the shell (header, layout hosts, bootstrap); the
 * browser module `desk-client.js` renders the controls with the
 * `kyberion-base` catalog. Every user-visible string comes from the
 * `daily_desk` vocabulary for the request's locale.
 */
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import type { SupportedLocale } from '@agent/core/locale-normalize';
import type { VocabularyKey } from '@agent/core/t';
import { padT, renderPadHeader, renderPadPage } from '../lib/pad-ui.js';

export interface DailyDeskPageConfig {
  token: string;
  exportUrl: string;
  loadUrl: string;
  defaultInstruction?: string;
  outLabel: string;
  locale: SupportedLocale;
  journal: string;
  todo: string;
  now: string;
  /** Today's period key (the faces load only after the authenticated /load). */
  periodKey: string;
  facePaths: {
    journal: string | null;
    todo: string | null;
    now: string | null;
  };
}

export const DAILY_DESK_CLIENT_SCRIPT = 'scripts/daily-desk/desk-client.js';

/** Vocabulary the browser module reads through `t(key)`. */
export const DAILY_DESK_TEXT_KEYS = [
  'daily_desk:toolbar_label',
  'daily_desk:journal',
  'daily_desk:todo',
  'daily_desk:now',
  'daily_desk:face_path',
  'daily_desk:face_none',
  'daily_desk:faces_pending',
  'daily_desk:faces_seeded',
  'daily_desk:faces_missing',
  'daily_desk:instruction',
  'daily_desk:instruction_placeholder',
  'daily_desk:handoff',
  'daily_desk:save_draft',
  'daily_desk:load_disk',
  'daily_desk:clear',
  'daily_desk:ready',
  'daily_desk:draft_saved',
  'daily_desk:exporting',
  'daily_desk:exported',
  'daily_desk:export_failed',
  'daily_desk:loading',
  'daily_desk:loaded',
  'daily_desk:load_failed',
  'daily_desk:clear_confirm',
  'daily_desk:clear_confirm_body',
  'daily_desk:cleared',
  'daily_desk:out_path',
] as const satisfies readonly VocabularyKey[];

const BODY_HTML = [
  '<div class="kb-stack" data-gap="md">',
  '<div id="dk-toolbar"></div>',
  '<div id="dk-note"></div>',
  '<div id="dk-faces"></div>',
  '<div id="dk-instruction"></div>',
  '<div id="pad-dialog"></div>',
  '</div>',
].join('');

function clientScript(): string {
  return String(
    safeReadFile(pathResolver.rootResolve(DAILY_DESK_CLIENT_SCRIPT), { encoding: 'utf8' })
  );
}

export function dailyDeskPageHtml(config: DailyDeskPageConfig): string {
  const t = padT(config.locale);
  const title = t('daily_desk:title');
  return renderPadPage({
    locale: config.locale,
    title,
    role: 'daily-desk',
    bodyHtml:
      renderPadHeader({
        locale: config.locale,
        title,
        subtitle: t('daily_desk:subtitle'),
      }) + BODY_HTML,
    scriptModule: clientScript(),
    textKeys: DAILY_DESK_TEXT_KEYS,
    bootstrap: {
      token: config.token,
      exportUrl: config.exportUrl,
      loadUrl: config.loadUrl,
      defaultInstruction: config.defaultInstruction ?? '',
      outLabel: config.outLabel,
      periodKey: config.periodKey,
      faces: { journal: config.journal, todo: config.todo, now: config.now },
      facePaths: config.facePaths,
    },
  });
}
