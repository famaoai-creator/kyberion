/**
 * sketch-page.ts — the sketch-input pad page on the shared A2UI kit (PA-04).
 *
 * The page is `renderPadPage` + `renderPadHeader` (scripts/lib/pad-ui.ts) in
 * the request's locale; the browser module `sketch-client.js` renders the
 * controls as `kyberion-base` components (`ui:toolbar`, `ui:sketch-board`,
 * `ui:textarea`, `ui:voice-input`). Export still posts PNG + instruction to
 * the local server (`/export`, `X-SK-Token`).
 */
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import type { SupportedLocale } from '@agent/core/locale-normalize';
import type { VocabularyKey } from '@agent/core/t';
import { escapePadHtml, padT, renderPadHeader, renderPadPage } from '../lib/pad-ui.js';

export interface SketchPageConfig {
  locale: SupportedLocale;
  token: string;
  exportUrl: string;
  defaultInstruction?: string;
  outLabel: string;
}

export const SKETCH_CANVAS_SIZE = Object.freeze({ width: 1280, height: 720 });
export const SKETCH_CLIENT_SCRIPT = 'scripts/sketch-input/sketch-client.js';

/** Vocabulary the browser module reads via `t(key)`. */
export const SKETCH_PAGE_TEXT_KEYS = [
  'sketch_input:toolbar_label',
  'sketch_input:board_label',
  'sketch_input:handoff',
  'sketch_input:ready',
  'sketch_input:exporting',
  'sketch_input:exported_detail',
  'sketch_input:export_failed_detail',
  'sketch_input:instruction',
  'sketch_input:instruction_placeholder',
  'sketch_input:voice_label',
  'sketch_input:dictation_note',
] as const satisfies readonly VocabularyKey[];

function clientModuleSource(): string {
  return String(safeReadFile(pathResolver.rootResolve(SKETCH_CLIENT_SCRIPT), { encoding: 'utf8' }));
}

export function sketchPageHtml(config: SketchPageConfig): string {
  const t = padT(config.locale);
  const title = t('sketch_input:title');
  const bodyHtml = [
    renderPadHeader({ locale: config.locale, title, subtitle: t('sketch_input:subtitle') }),
    '<div class="kb-stack" data-gap="md">',
    '<div id="sk-toolbar"></div>',
    '<div id="sk-board"></div>',
    '<section class="kb-section">',
    '<div id="sk-instruction"></div>',
    '<div id="sk-voice"></div>',
    `<p class="kb-text kb-text--muted" id="sk-out">${escapePadHtml(
      t('sketch_input:out_path', { path: config.outLabel })
    )}</p>`,
    '</section>',
    '</div>',
  ].join('');
  return renderPadPage({
    locale: config.locale,
    title,
    role: 'sketch-input',
    bodyHtml,
    textKeys: SKETCH_PAGE_TEXT_KEYS,
    bootstrap: {
      token: config.token,
      exportUrl: config.exportUrl,
      defaultInstruction: config.defaultInstruction ?? '',
      canvas: SKETCH_CANVAS_SIZE,
    },
    scriptModule: clientModuleSource(),
  });
}
