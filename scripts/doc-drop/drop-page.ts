/**
 * drop-page.ts — doc-drop page on the shared A2UI kit (PA-06).
 *
 * The server renders the shell (header, layout hosts, bootstrap); the
 * browser module `drop-client.js` renders the controls with the
 * `kyberion-base` catalog (toolbar with a file picker, `ui:file-drop` with
 * per-file status, `ui:camera-capture`, instruction, clear confirmation).
 * Every user-visible string comes from the `doc_drop` vocabulary for the
 * request's locale.
 */
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import type { SupportedLocale } from '@agent/core/locale-normalize';
import type { VocabularyKey } from '@agent/core/t';
import { padT, renderPadHeader, renderPadPage } from '../lib/pad-ui.js';

export interface DocDropPageConfig {
  token: string;
  exportUrl: string;
  defaultInstruction?: string;
  outLabel: string;
  locale: SupportedLocale;
  /** Per-file limit the page screens against (the server enforces its own). */
  maxFileBytes: number;
}

export const DOC_DROP_CLIENT_SCRIPT = 'scripts/doc-drop/drop-client.js';

/** Types the picker offers (extensions only: the kit lists them in its hint). */
export const DOC_DROP_ACCEPT = '.pdf,image/*,.txt,.md,.docx';

/** Vocabulary the browser module reads through `t(key)`. */
export const DOC_DROP_TEXT_KEYS = [
  'doc_drop:toolbar_label',
  'doc_drop:files_label',
  'doc_drop:attach',
  'doc_drop:camera',
  'doc_drop:camera_label',
  'doc_drop:handoff',
  'doc_drop:clear',
  'doc_drop:instruction',
  'doc_drop:instruction_placeholder',
  'doc_drop:ready',
  'doc_drop:exporting',
  'doc_drop:exported',
  'doc_drop:export_failed',
  'doc_drop:need_files',
  'doc_drop:attach_added',
  'doc_drop:attach_too_large',
  'doc_drop:attach_read_failed',
  'doc_drop:clear_confirm',
  'doc_drop:clear_confirm_body',
  'doc_drop:cleared',
  'doc_drop:out_path',
] as const satisfies readonly VocabularyKey[];

const BODY_HTML = [
  '<div class="kb-stack" data-gap="md">',
  '<div id="dd-toolbar"></div>',
  '<div class="kb-grid" data-gap="lg" data-min-column-width="lg">',
  '<div class="kb-stack" data-gap="md">',
  '<div id="dd-files"></div>',
  '<div id="dd-instruction"></div>',
  '</div>',
  '<div id="dd-camera" hidden></div>',
  '</div>',
  '<div id="pad-dialog"></div>',
  '</div>',
].join('');

function clientScript(): string {
  return String(
    safeReadFile(pathResolver.rootResolve(DOC_DROP_CLIENT_SCRIPT), { encoding: 'utf8' })
  );
}

export function docDropPageHtml(config: DocDropPageConfig): string {
  const t = padT(config.locale);
  const title = t('doc_drop:title');
  return renderPadPage({
    locale: config.locale,
    title,
    role: 'doc-drop',
    bodyHtml:
      renderPadHeader({
        locale: config.locale,
        title,
        subtitle: t('doc_drop:subtitle'),
      }) + BODY_HTML,
    scriptModule: clientScript(),
    textKeys: DOC_DROP_TEXT_KEYS,
    bootstrap: {
      token: config.token,
      exportUrl: config.exportUrl,
      defaultInstruction: config.defaultInstruction ?? '',
      outLabel: config.outLabel,
      accept: DOC_DROP_ACCEPT,
      maxFileBytes: config.maxFileBytes,
    },
  });
}
