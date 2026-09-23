/**
 * page.ts — clipboard-inbox page on the shared A2UI kit (PA-06): park pasted
 * clips, pull the OS clipboard when available, hand them off.
 *
 * The server renders the shell (header, layout hosts, bootstrap); the
 * browser module `inbox-client.js` renders the controls with the
 * `kyberion-base` catalog (toolbar, item list with remove, new-item /
 * label / instruction fields, secrets callout, clear-all confirmation).
 * Every user-visible string comes from the `clipboard_inbox` vocabulary for
 * the request's locale.
 */
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import type { SupportedLocale } from '@agent/core/locale-normalize';
import type { VocabularyKey } from '@agent/core/t';
import { padT, renderPadHeader, renderPadPage } from '../lib/pad-ui.js';

export interface ClipboardInboxPageConfig {
  token: string;
  exportUrl: string;
  clipboardReadUrl: string;
  defaultInstruction?: string;
  outLabel: string;
  locale: SupportedLocale;
}

export const CLIPBOARD_INBOX_CLIENT_SCRIPT = 'scripts/clipboard-inbox/inbox-client.js';

/** Vocabulary the browser module reads through `t(key)`. */
export const CLIPBOARD_INBOX_TEXT_KEYS = [
  'clipboard_inbox:toolbar_label',
  'clipboard_inbox:items',
  'clipboard_inbox:empty',
  'clipboard_inbox:empty_body',
  'clipboard_inbox:item_title',
  'clipboard_inbox:item_meta',
  'clipboard_inbox:new_item',
  'clipboard_inbox:new_placeholder',
  'clipboard_inbox:label',
  'clipboard_inbox:label_placeholder',
  'clipboard_inbox:add',
  'clipboard_inbox:pull',
  'clipboard_inbox:delete',
  'clipboard_inbox:instruction',
  'clipboard_inbox:instruction_placeholder',
  'clipboard_inbox:handoff',
  'clipboard_inbox:clear_all',
  'clipboard_inbox:ready',
  'clipboard_inbox:exporting',
  'clipboard_inbox:exported',
  'clipboard_inbox:export_failed',
  'clipboard_inbox:added',
  'clipboard_inbox:removed',
  'clipboard_inbox:pulled',
  'clipboard_inbox:pull_fail',
  'clipboard_inbox:need_items',
  'clipboard_inbox:need_text',
  'clipboard_inbox:clear_confirm',
  'clipboard_inbox:clear_confirm_body',
  'clipboard_inbox:cleared',
  'clipboard_inbox:redact_title',
  'clipboard_inbox:redact_hint',
  'clipboard_inbox:out_path',
] as const satisfies readonly VocabularyKey[];

const BODY_HTML = [
  '<div class="kb-stack" data-gap="md">',
  '<div id="ci-toolbar"></div>',
  '<div class="kb-grid" data-gap="lg" data-min-column-width="lg">',
  '<div id="ci-items"></div>',
  '<div class="kb-stack" data-gap="md">',
  '<div id="ci-new"></div>',
  '<div id="ci-instruction"></div>',
  '</div>',
  '</div>',
  '<div id="pad-dialog"></div>',
  '</div>',
].join('');

function clientScript(): string {
  return String(
    safeReadFile(pathResolver.rootResolve(CLIPBOARD_INBOX_CLIENT_SCRIPT), { encoding: 'utf8' })
  );
}

export function clipboardInboxPageHtml(config: ClipboardInboxPageConfig): string {
  const t = padT(config.locale);
  const title = t('clipboard_inbox:title');
  return renderPadPage({
    locale: config.locale,
    title,
    role: 'clipboard-inbox',
    bodyHtml:
      renderPadHeader({
        locale: config.locale,
        title,
        subtitle: t('clipboard_inbox:subtitle'),
      }) + BODY_HTML,
    scriptModule: clientScript(),
    textKeys: CLIPBOARD_INBOX_TEXT_KEYS,
    bootstrap: {
      token: config.token,
      exportUrl: config.exportUrl,
      clipboardReadUrl: config.clipboardReadUrl,
      defaultInstruction: config.defaultInstruction ?? '',
      outLabel: config.outLabel,
    },
  });
}
