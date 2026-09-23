/**
 * notepad-page.ts — meeting notepad page on the shared A2UI kit (PA-06).
 *
 * The server renders the shell (header, layout hosts, bootstrap); the
 * browser module `notepad-client.js` renders every control with the
 * `kyberion-base` catalog: toolbar, title / notes / transcript / instruction
 * fields, dictation and chunked recording (`ui:voice-input`), attachments
 * (`ui:file-drop`), camera (`ui:camera-capture`), minutes preview and the
 * clear confirmation (`ui:dialog`). Every user-visible string comes from the
 * `meeting_notepad` vocabulary for the request's locale.
 */
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import type { SupportedLocale } from '@agent/core/locale-normalize';
import type { VocabularyKey } from '@agent/core/t';
import { padT, renderPadHeader, renderPadPage, renderPadStickyHost } from '../lib/pad-ui.js';

export interface MeetingNotepadPageConfig {
  token: string;
  exportUrl: string;
  minutesUrl: string;
  transcribeUrl: string;
  defaultInstruction?: string;
  defaultTitle?: string;
  outLabel: string;
  locale: SupportedLocale;
}

export const MEETING_NOTEPAD_CLIENT_SCRIPT = 'scripts/meeting-notepad/notepad-client.js';

/** Vocabulary the browser module reads through `t(key)`. */
export const MEETING_NOTEPAD_TEXT_KEYS = [
  'meeting_notepad:toolbar_label',
  'meeting_notepad:meeting_title',
  'meeting_notepad:meeting_title_placeholder',
  'meeting_notepad:notes',
  'meeting_notepad:notes_placeholder',
  'meeting_notepad:transcript',
  'meeting_notepad:transcript_placeholder',
  'meeting_notepad:instruction',
  'meeting_notepad:instruction_placeholder',
  'meeting_notepad:dictation_label',
  'meeting_notepad:dictation_note',
  'meeting_notepad:record_label',
  'meeting_notepad:record_help',
  'meeting_notepad:recording',
  'meeting_notepad:recording_stopped',
  'meeting_notepad:recording_error',
  'meeting_notepad:transcribing',
  'meeting_notepad:transcribe_unavailable',
  'meeting_notepad:voice_error',
  'meeting_notepad:camera',
  'meeting_notepad:camera_label',
  'meeting_notepad:camera_error',
  'meeting_notepad:attach',
  'meeting_notepad:attachments',
  'meeting_notepad:attach_added',
  'meeting_notepad:attach_too_large',
  'meeting_notepad:attach_read_failed',
  'meeting_notepad:create_minutes',
  'meeting_notepad:handoff',
  'meeting_notepad:restore',
  'meeting_notepad:clear',
  'meeting_notepad:clear_confirm',
  'meeting_notepad:clear_confirm_body',
  'meeting_notepad:cleared',
  'meeting_notepad:draft_restored',
  'meeting_notepad:draft_without_attachments',
  'meeting_notepad:no_draft',
  'meeting_notepad:ready',
  'meeting_notepad:exporting',
  'meeting_notepad:exported',
  'meeting_notepad:export_failed',
  'meeting_notepad:minutes_running',
  'meeting_notepad:minutes_done',
  'meeting_notepad:minutes_failed',
  'meeting_notepad:preview',
  'meeting_notepad:preview_empty',
  'meeting_notepad:out_path',
] as const satisfies readonly VocabularyKey[];

/** Page layout: one host per independently re-rendered component group. */
const BODY_HTML = [
  '<div class="kb-stack" data-gap="md">',
  renderPadStickyHost('mn-toolbar'),
  '<div class="kb-grid" data-gap="lg" data-min-column-width="lg">',
  '<div class="kb-stack" data-gap="md">',
  '<div id="mn-fields"></div>',
  '<div id="mn-dictation"></div>',
  '<div id="mn-record"></div>',
  '<div id="mn-record-state"></div>',
  '<div id="mn-fields-more"></div>',
  '</div>',
  '<div class="kb-stack" data-gap="md">',
  '<div id="mn-attachments"></div>',
  '<div id="mn-camera" hidden></div>',
  '<div id="mn-preview"></div>',
  '</div>',
  '</div>',
  '<div id="pad-dialog"></div>',
  '</div>',
].join('');

function clientScript(): string {
  return String(
    safeReadFile(pathResolver.rootResolve(MEETING_NOTEPAD_CLIENT_SCRIPT), { encoding: 'utf8' })
  );
}

export function meetingNotepadPageHtml(config: MeetingNotepadPageConfig): string {
  const t = padT(config.locale);
  const title = t('meeting_notepad:title');
  return renderPadPage({
    locale: config.locale,
    title,
    role: 'meeting-notepad',
    bodyHtml:
      renderPadHeader({
        locale: config.locale,
        title,
        subtitle: t('meeting_notepad:subtitle'),
      }) + BODY_HTML,
    scriptModule: clientScript(),
    textKeys: MEETING_NOTEPAD_TEXT_KEYS,
    bootstrap: {
      token: config.token,
      exportUrl: config.exportUrl,
      minutesUrl: config.minutesUrl,
      transcribeUrl: config.transcribeUrl,
      defaultInstruction: config.defaultInstruction ?? '',
      defaultTitle: config.defaultTitle ?? '',
      outLabel: config.outLabel,
      language: config.locale === 'ja' ? 'ja' : 'en',
    },
  });
}
