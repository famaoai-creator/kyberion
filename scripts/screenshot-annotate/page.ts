/**
 * page.ts — the screenshot-annotate pad page on the shared A2UI kit (PA-04).
 *
 * The page is `renderPadPage` + `renderPadHeader` (scripts/lib/pad-ui.ts) in
 * the request's locale, all copy from the `screenshot_annotate` vocabulary.
 * The browser module `annotate-client.js` renders `ui:toolbar`,
 * `ui:sketch-board` (the loaded image is its background), `ui:textarea` and
 * `ui:voice-input`.
 */
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import type { SupportedLocale } from '@agent/core/locale-normalize';
import type { VocabularyKey } from '@agent/core/t';
import { escapePadHtml, padT, renderPadHeader, renderPadPage } from '../lib/pad-ui.js';

export interface ScreenshotAnnotatePageConfig {
  locale: SupportedLocale;
  token: string;
  exportUrl: string;
  screenshotUrl: string;
  defaultInstruction?: string;
  outLabel: string;
}

export const SCREENSHOT_ANNOTATE_CANVAS_SIZE = Object.freeze({ width: 1280, height: 720 });
export const SCREENSHOT_ANNOTATE_CLIENT_SCRIPT = 'scripts/screenshot-annotate/annotate-client.js';

/** Vocabulary the browser module reads via `t(key)`. */
export const SCREENSHOT_ANNOTATE_TEXT_KEYS = [
  'screenshot_annotate:toolbar_label',
  'screenshot_annotate:board_label',
  'screenshot_annotate:load_image',
  'screenshot_annotate:os_capture',
  'screenshot_annotate:handoff',
  'screenshot_annotate:ready',
  'screenshot_annotate:exporting',
  'screenshot_annotate:exported_detail',
  'screenshot_annotate:export_failed_detail',
  'screenshot_annotate:image_loaded',
  'screenshot_annotate:image_needed',
  'screenshot_annotate:capture_ok',
  'screenshot_annotate:capture_failed_detail',
  'screenshot_annotate:instruction',
  'screenshot_annotate:instruction_placeholder',
  'screenshot_annotate:voice_label',
  'screenshot_annotate:dictation_note',
] as const satisfies readonly VocabularyKey[];

function clientModuleSource(): string {
  return String(
    safeReadFile(pathResolver.rootResolve(SCREENSHOT_ANNOTATE_CLIENT_SCRIPT), {
      encoding: 'utf8',
    })
  );
}

export function screenshotAnnotatePageHtml(config: ScreenshotAnnotatePageConfig): string {
  const t = padT(config.locale);
  const title = t('screenshot_annotate:title');
  const bodyHtml = [
    renderPadHeader({ locale: config.locale, title, subtitle: t('screenshot_annotate:subtitle') }),
    '<div class="kb-stack" data-gap="md">',
    '<div id="sa-toolbar"></div>',
    '<div id="sa-board"></div>',
    '<section class="kb-section">',
    '<div id="sa-instruction"></div>',
    '<div id="sa-voice"></div>',
    `<p class="kb-text kb-text--muted" id="sa-out">${escapePadHtml(
      t('screenshot_annotate:out_path', { path: config.outLabel })
    )}</p>`,
    '</section>',
    '</div>',
  ].join('');
  return renderPadPage({
    locale: config.locale,
    title,
    role: 'screenshot-annotate',
    bodyHtml,
    textKeys: SCREENSHOT_ANNOTATE_TEXT_KEYS,
    bootstrap: {
      token: config.token,
      exportUrl: config.exportUrl,
      screenshotUrl: config.screenshotUrl,
      defaultInstruction: config.defaultInstruction ?? '',
      canvas: SCREENSHOT_ANNOTATE_CANVAS_SIZE,
    },
    scriptModule: clientModuleSource(),
  });
}
