/**
 * page.ts — memory-capture page on the shared A2UI kit (PA-06).
 *
 * The server renders the shell (header, layout hosts, bootstrap); the
 * browser module `capture-client.js` renders the controls with the
 * `kyberion-base` catalog (toolbar, notes + dictation, tags, target,
 * instruction, clear confirmation). Every user-visible string comes from the
 * `memory_capture` vocabulary for the request's locale.
 */
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import type { SupportedLocale } from '@agent/core/locale-normalize';
import type { VocabularyKey } from '@agent/core/t';
import { padT, renderPadHeader, renderPadPage } from '../lib/pad-ui.js';

export interface MemoryCapturePageConfig {
  token: string;
  exportUrl: string;
  defaultInstruction?: string;
  outLabel: string;
  locale: SupportedLocale;
}

export const MEMORY_CAPTURE_CLIENT_SCRIPT = 'scripts/memory-capture/capture-client.js';

/** Vocabulary the browser module reads through `t(key)`. */
export const MEMORY_CAPTURE_TEXT_KEYS = [
  'memory_capture:toolbar_label',
  'memory_capture:notes',
  'memory_capture:notes_placeholder',
  'memory_capture:tags',
  'memory_capture:tags_placeholder',
  'memory_capture:target',
  'memory_capture:target_memory',
  'memory_capture:target_now',
  'memory_capture:target_todo',
  'memory_capture:instruction',
  'memory_capture:instruction_placeholder',
  'memory_capture:dictation_label',
  'memory_capture:dictation_note',
  'memory_capture:handoff',
  'memory_capture:restore',
  'memory_capture:clear',
  'memory_capture:ready',
  'memory_capture:exporting',
  'memory_capture:exported',
  'memory_capture:export_failed',
  'memory_capture:clear_confirm',
  'memory_capture:clear_confirm_body',
  'memory_capture:draft_restored',
  'memory_capture:draft_cleared',
  'memory_capture:no_draft',
  'memory_capture:out_path',
] as const satisfies readonly VocabularyKey[];

const BODY_HTML = [
  '<div class="kb-stack" data-gap="md">',
  '<div id="mc-toolbar"></div>',
  '<div class="kb-grid" data-gap="lg" data-min-column-width="lg">',
  '<div class="kb-stack" data-gap="md">',
  '<div id="mc-notes"></div>',
  '<div id="mc-voice"></div>',
  '<div id="mc-meta"></div>',
  '</div>',
  '<div id="mc-instruction"></div>',
  '</div>',
  '<div id="pad-dialog"></div>',
  '</div>',
].join('');

function clientScript(): string {
  return String(
    safeReadFile(pathResolver.rootResolve(MEMORY_CAPTURE_CLIENT_SCRIPT), { encoding: 'utf8' })
  );
}

export function memoryCapturePageHtml(config: MemoryCapturePageConfig): string {
  const t = padT(config.locale);
  const title = t('memory_capture:title');
  return renderPadPage({
    locale: config.locale,
    title,
    role: 'memory-capture',
    bodyHtml:
      renderPadHeader({
        locale: config.locale,
        title,
        subtitle: t('memory_capture:subtitle'),
      }) + BODY_HTML,
    scriptModule: clientScript(),
    textKeys: MEMORY_CAPTURE_TEXT_KEYS,
    bootstrap: {
      token: config.token,
      exportUrl: config.exportUrl,
      defaultInstruction: config.defaultInstruction ?? '',
      outLabel: config.outLabel,
    },
  });
}
