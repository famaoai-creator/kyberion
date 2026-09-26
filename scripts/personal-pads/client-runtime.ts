/**
 * Browser runtime seam of the unified pads desk (PA-04 / PA-07).
 *
 * The runtime itself is the ES module `client/app.js` (served at
 * `PERSONAL_PADS_CLIENT_ROUTE`), built on the shared A2UI kit through
 * `/pad-ui/pad-client.js`. Pad-specific behavior stays data-driven: the page
 * embeds the localized adapter contract in the `#pad-bootstrap` JSON, and the
 * runtime maps each adapter field kind to a `kyberion-base` component.
 *
 * Every user-visible browser string is a `personal_pads:*` vocabulary key
 * listed in `PERSONAL_PADS_CLIENT_TEXT_KEYS`; `renderPadPage` ships their
 * text for the request locale.
 */
import type { LocalPadContext } from '../lib/local-artifact-pad.js';
import type { VocabularyKey } from '@agent/core/t';
import { getSurfaceContract, type PadSurfaceContract, type PadTop } from './surface.js';
import { allowedPadTiers, type PadTier } from './storage.js';

export const PERSONAL_PADS_CLIENT_ROUTE = '/personal-pads/app.js';
/** Browser modules of the runtime: fixed route → repository file (no path parameter). */
export const PERSONAL_PADS_CLIENT_MODULES: Readonly<Record<string, string>> = Object.freeze({
  [PERSONAL_PADS_CLIENT_ROUTE]: 'scripts/personal-pads/client/app.js',
  '/personal-pads/support.js': 'scripts/personal-pads/client/support.js',
});

/** Vocabulary the browser runtime reads via `t(key)`. */
export const PERSONAL_PADS_CLIENT_TEXT_KEYS = [
  'personal_pads:nav_label',
  'personal_pads:scope_tenant',
  'personal_pads:scope_tier',
  'personal_pads:scope_viewer',
  'personal_pads:tier_label',
  'personal_pads:tier_personal',
  'personal_pads:tier_confidential',
  'personal_pads:tier_public',
  'personal_pads:storage_personal',
  'personal_pads:storage_confidential',
  'personal_pads:storage_public',
  'personal_pads:storage_note',
  'personal_pads:title_label',
  'personal_pads:title_placeholder',
  'personal_pads:body_label',
  'personal_pads:body_label_composed',
  'personal_pads:body_placeholder',
  'personal_pads:body_placeholder_composed',
  'personal_pads:save',
  'personal_pads:clear_draft',
  'personal_pads:history_refresh',
  'personal_pads:history_more',
  'personal_pads:history_empty',
  'personal_pads:history_empty_body',
  'personal_pads:history_saved_record',
  'personal_pads:history_attachments',
  'personal_pads:result_title',
  'personal_pads:record_in_browser',
  'personal_pads:action_checking',
  'personal_pads:action_check_on_click',
  'personal_pads:request_failed',
  'personal_pads:status_wait_busy',
  'personal_pads:status_wait_history',
  'personal_pads:status_wait_switch',
  'personal_pads:status_action_running',
  'personal_pads:status_action_unavailable',
  'personal_pads:status_action_done',
  'personal_pads:status_action_failed',
  'personal_pads:status_attachment_read_failed',
  'personal_pads:status_attachment_load_failed',
  'personal_pads:status_loading_attachments',
  'personal_pads:status_need_content',
  'personal_pads:status_saving',
  'personal_pads:status_saved',
  'personal_pads:status_saved_kept',
  'personal_pads:status_save_failed',
  'personal_pads:status_cleared',
  'personal_pads:status_restored',
  'personal_pads:status_recording_captured',
  'personal_pads:status_recording_read_failed',
  'personal_pads:status_drawing_export_failed',
  'personal_pads:dialog_unsaved_title',
  'personal_pads:dialog_unsaved_message',
  'personal_pads:dialog_save',
  'personal_pads:dialog_discard',
  'personal_pads:dialog_cancel',
  'personal_pads:plugin_views_title',
  'personal_pads:plugin_views_empty',
  'personal_pads:plugin_view_action_in_chronos',
] as const satisfies readonly VocabularyKey[];

export const PERSONAL_PADS_TIERS = ['personal', 'confidential', 'public'] as const;

export interface PersonalPadsBootstrap {
  token: string;
  top: PadTop;
  scope: LocalPadContext['scope'];
  viewer_principal: string;
  /** Tiers this server scope may select (others are shown disabled). */
  allowed_tiers: readonly PadTier[];
  tiers: readonly PadTier[];
  pads: PadSurfaceContract['menu'];
  adapters: PadSurfaceContract['content'];
}

/** The pad-specific part of `#pad-bootstrap` (the kit adds locale / messages / texts). */
export function personalPadsBootstrap(
  token: string,
  context: LocalPadContext,
  top: PadTop,
  contract: PadSurfaceContract = getSurfaceContract()
): PersonalPadsBootstrap {
  return {
    token,
    top,
    scope: context.scope,
    viewer_principal: context.viewer_principal,
    allowed_tiers: allowedPadTiers(context.scope.tier as PadTier),
    tiers: PERSONAL_PADS_TIERS,
    pads: contract.menu,
    adapters: contract.content,
  };
}

/** Inline module that starts the runtime (all data comes from `#pad-bootstrap`). */
export function personalPadsClientModule(): string {
  return `import { startPersonalPads } from '${PERSONAL_PADS_CLIENT_ROUTE}';\nstartPersonalPads();`;
}
