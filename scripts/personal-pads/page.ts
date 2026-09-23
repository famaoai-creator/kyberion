/**
 * The unified pads desk page (PA-04), on the shared pad UI foundation
 * (`scripts/lib/pad-ui.ts`): kit stylesheet + tokens, theme / language
 * display controls, per-request locale.
 *
 * Layout: shell nav column (`ui:nav-rail` of pads) · header (title, scope
 * chips, display controls) · editor (fields → kit components) · history.
 * The server renders only the static frames in the request locale; the
 * browser runtime (`client/app.js`) renders every component into its own
 * `[data-pp-*]` container, so stateful ones (sketch board, voice input) are
 * never re-rendered while in use.
 */
import type { LocalPadContext } from '../lib/local-artifact-pad.js';
import type { SupportedLocale } from '@agent/core/locale-normalize';
import { escapePadHtml, renderPadHeader, renderPadPage } from '../lib/pad-ui.js';
import { PERSONAL_PADS_SURFACE, storageLabelForTier, type PersonalPadsSurface } from './surface.js';
import {
  PERSONAL_PADS_CLIENT_TEXT_KEYS,
  personalPadsBootstrap,
  personalPadsClientModule,
} from './client-runtime.js';
import { defaultPadLocale, padsT } from './i18n.js';

export { storageLabelForTier };

/** Layout glue only (grid areas / scroll); every color and type style comes from the kit. */
const PAGE_CSS = [
  '.pp-scope{display:flex;flex-wrap:wrap;gap:var(--kb-ui-space-2)}',
  '.pp-workspace{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,360px);gap:var(--kb-ui-space-5);align-items:start}',
  '.pp-editor,.pp-fields,.pp-actions,.pp-field{display:flex;flex-direction:column;gap:var(--kb-ui-space-4);min-width:0}',
  '.pp-field{gap:var(--kb-ui-space-2)}',
  '.pp-action{display:flex;flex-direction:column;gap:var(--kb-ui-space-3);padding-top:var(--kb-ui-space-3);border-top:1px solid var(--kb-ui-border)}',
  '.pp-actions:empty,.pp-status:empty,.pp-result:empty{display:none}',
  '.pp-history{position:sticky;top:var(--kb-ui-space-5)}',
  '.pp-history-list{max-height:64vh;overflow:auto}',
  '@media (max-width:1100px){.pp-workspace{grid-template-columns:minmax(0,1fr)}.pp-history{position:static}}',
].join('\n');

/** Static `ui:section` heading markup; `data` names the runtime hook on the title / description. */
function sectionHeading(id: string, title: string, description?: string, data?: string): string {
  const hook = (suffix: string) => (data ? ` data-${data}-${suffix}` : '');
  const text =
    description === undefined
      ? ''
      : `<p class="kb-section__description"${hook('description')}>${escapePadHtml(description)}</p>`;
  return `<div class="kb-section__heading"><h2 class="kb-section__title" id="${id}"${hook('title')}>${escapePadHtml(title)}</h2>${text}</div>`;
}

export function personalPadsPage(
  token: string,
  context: LocalPadContext,
  surface: PersonalPadsSurface = PERSONAL_PADS_SURFACE,
  locale?: SupportedLocale
): string {
  const resolved = defaultPadLocale(locale);
  const t = padsT(resolved);
  const menu = surface.getMenu(resolved);
  const defaultPad = menu[0];
  const top = surface.getTop(context, resolved);
  const contract = surface.getSurfaceContract(resolved);
  const header = renderPadHeader({
    locale: resolved,
    title: top.title,
    subtitle: top.subtitle,
    actionsHtml: '<div class="pp-scope" data-pp-scope></div>',
  });
  const bodyHtml = [
    header,
    '<div class="pp-workspace" data-pp-workspace>',
    '<section class="kb-section pp-editor" aria-labelledby="pp-pad-title">',
    `<header class="kb-section__header">${sectionHeading(
      'pp-pad-title',
      defaultPad?.label ?? '',
      defaultPad?.description ?? '',
      'pp-pad'
    )}</header>`,
    '<div data-pp-tier></div>',
    '<div class="pp-fields" data-pp-fields></div>',
    `<div class="pp-actions" data-pp-actions role="group" aria-label="${escapePadHtml(t('personal_pads:actions_label'))}"></div>`,
    '<div data-pp-title></div>',
    '<div data-pp-body></div>',
    '<div data-pp-save></div>',
    '<div class="pp-status" data-pp-status role="status" aria-live="polite"></div>',
    '<div class="pp-result" data-pp-result></div>',
    `<div data-pp-storage><p class="kb-text kb-text--caption">${escapePadHtml(
      t('personal_pads:storage_note', {
        label: storageLabelForTier(String(top.scope.tier), defaultPad?.label ?? '', resolved),
      })
    )}</p></div>`,
    '</section>',
    '<aside class="kb-section pp-history" aria-labelledby="pp-history-title">',
    `<header class="kb-section__header">${sectionHeading('pp-history-title', t('personal_pads:history_title'))}<div class="kb-section__actions" data-pp-history-actions></div></header>`,
    '<div class="pp-history-list" data-pp-history></div>',
    '<div data-pp-history-more></div>',
    '</aside>',
    '</div>',
    '<div data-pp-dialog></div>',
  ].join('');
  return renderPadPage({
    locale: resolved,
    title: top.title,
    bodyHtml,
    navHtml: '<div data-pp-nav></div>',
    headExtra: `<style>${PAGE_CSS}</style>`,
    scriptModule: personalPadsClientModule(),
    bootstrap: { ...personalPadsBootstrap(token, context, top, contract) },
    textKeys: PERSONAL_PADS_CLIENT_TEXT_KEYS,
    density: 'compact',
    role: 'personal-pads',
  });
}

/** Kept as a seam for future CSP nonce and shell-level instrumentation. */
export function augmentPersonalPadsPage(page: string): string {
  return page;
}
