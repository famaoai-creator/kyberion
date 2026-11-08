/** Pure Ask view projection. Next actions only describe bounded editable drafts.
 * They carry no approval or execution authority; the enclosing durable HTTP
 * reply supplies request/session provenance separately. */
import { isRecord } from '../foundation/primitives.js';
import {
  parseIntentResolutionContract,
  type IntentResolutionContract,
  type IntentResolutionShape,
} from '../intent/intent-resolution-contract-parser.js';
import { z } from 'zod';
import type { VocabularyKey } from '../localization/t.js';
import type { ConversationHistory } from './front-desk-conversation-history.js';

export type AskConversationShape =
  'clarification' | 'execution_preview' | 'status_summary' | 'delivery_summary' | 'reply';

/**
 * FD-09: `resolution_shape` -> a `front_desk` vocabulary key with plain
 * front-desk wording. Deliberately does *not* reuse the existing
 * `tui:tui_cockpit_shape_*` keys (`knowledge/product/orchestration/user-facing-vocabulary.json`)
 * even though those already cover all four `IntentResolutionShape` values:
 * their English text for `mission` is the literal word "mission", which
 * `docs/developer/improvement-plans-2026-08/FRONT_DESK_REDESIGN_PLAN_2026-09-13.ja.md`
 * §0 item 2 explicitly bans from the front-desk human surfaces (presence-studio's
 * `front-desk-routes.test.ts` enforces this at the source-file level for
 * `presence/displays/presence-studio/static/ask.js`). Declared as an exhaustive
 * `Record` over `IntentResolutionShape` so a new enum member fails `tsc` here
 * before it can render as a raw internal id in that `static/ask.js`, which
 * mirrors this exact map as `SHAPE_LABEL_KEY` (a plain browser script cannot
 * import this module — see its own module doc). Used by: Studio, Concierge.
 */
export const ASK_SHAPE_LABEL_KEY: Record<IntentResolutionShape, VocabularyKey> = {
  direct_answer: 'front_desk:shape_direct_answer',
  task_session: 'front_desk:shape_task_session',
  mission: 'front_desk:shape_mission',
  project_bootstrap: 'front_desk:shape_project_bootstrap',
};

export interface AskNextAction {
  id: 'draft_input' | 'draft_review';
  label: string;
  consequence: string;
  missing_inputs: string[];
}

export interface AskConversationView {
  shape: AskConversationShape;
  nextActions?: AskNextAction[];
}

/**
 * FD-09: humanize a `kebab-case` (or `snake_case`) slug into plain words —
 * the deliberate last-resort fallback `resolveIntentLabel` below uses when
 * no standard-intent catalog entry names the intent. Never invents casing
 * or punctuation the slug did not already carry (see
 * `docs/developer/improvement-plans-2026-08/FRONT_DESK_REDESIGN_PLAN_2026-09-13.ja.md`
 * FD-09).
 */
export function humanizeSlug(slug: string): string {
  return slug.replace(/[-_]+/g, ' ').trim();
}

export interface AskIntentLabel {
  label: string;
  source: 'catalog' | 'slug';
}

/**
 * FD-09: resolve `normalized_intent` to human wording for the "What I
 * understood" block — the standard-intent catalog's own `description` when
 * the id is registered there, else a humanized slug as a last resort. Pure:
 * the caller (presence-studio `conversation-routes.ts`) passes in whatever
 * catalog lookup it already built from `loadStandardIntentCatalog()` so this
 * module stays I/O-free. Used by: Studio, Concierge.
 */
export function resolveIntentLabel(
  normalizedIntent: string,
  descriptionByIntentId: ReadonlyMap<string, string>
): AskIntentLabel {
  const description = descriptionByIntentId.get(normalizedIntent);
  if (description && description.trim().length > 0) {
    return { label: description, source: 'catalog' };
  }
  return { label: humanizeSlug(normalizedIntent), source: 'slug' };
}

function draftAction(
  contract: IntentResolutionContract,
  id: AskNextAction['id']
): AskNextAction | undefined {
  const action = contract.next_action;
  if (
    !isRecord(action) ||
    typeof action.label !== 'string' ||
    action.label.length > 256 ||
    !action.label.trim() ||
    typeof action.consequence !== 'string' ||
    action.consequence.length > 512 ||
    !action.consequence.trim() ||
    !Array.isArray(contract.missing_inputs) ||
    contract.missing_inputs.length > 8
  )
    return undefined;
  const missingInputs: string[] = [];
  for (const value of contract.missing_inputs) {
    if (typeof value !== 'string' || value.length > 96 || !value.trim()) return undefined;
    missingInputs.push(value.trim());
  }
  return {
    id,
    label: action.label.trim(),
    consequence: action.consequence.trim(),
    missing_inputs: missingInputs,
  };
}

/** Bounded editable-draft view of an intent resolution (distinct from the plain
 * label projection in `front-desk-request-projection.ts`). Used by: Studio, Concierge. */
export function viewFromIntentResolution(contract: IntentResolutionContract): AskConversationView {
  if (contract.authority_level === 'human_clarification_required') {
    const action =
      contract.next_action?.kind === 'provide_input'
        ? draftAction(contract, 'draft_input')
        : undefined;
    return { shape: 'clarification', ...(action ? { nextActions: [action] } : {}) };
  }
  if (contract.authority_level === 'approval_required') {
    const action =
      contract.next_action?.kind === 'request_approval'
        ? draftAction(contract, 'draft_review')
        : undefined;
    return { shape: 'execution_preview', ...(action ? { nextActions: [action] } : {}) };
  }
  return { shape: 'reply' };
}

const CONVERSATION_RESPONSE_DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Same prototype-pollution guard the concierge's `conversation-types.ts`
 * uses before an untrusted voice-hub JSON body is trusted any further. */
function hasSafeConversationTree(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(hasSafeConversationTree);
  if (!isRecord(value)) return true;
  return Object.entries(value).every(
    ([key, nested]) =>
      !CONVERSATION_RESPONSE_DANGEROUS_KEYS.has(key) && hasSafeConversationTree(nested)
  );
}

export interface AskVoiceHubReply {
  reply: string;
  intentResolution?: IntentResolutionContract;
}

/**
 * Parse the voice-hub `/api/ingest-text` response at this untrusted network
 * boundary — ported from the concierge's `parseVoiceHubConversationResponse`
 * (`presence/displays/concierge/src/lib/conversation-types.ts`) for the same
 * reason `viewFromIntentResolution` above is a from-scratch port rather than
 * an import.
 */
export function parseAskVoiceHubReply(value: unknown): AskVoiceHubReply | undefined {
  if (!isRecord(value) || !hasSafeConversationTree(value)) return undefined;
  const replyFields = ['reply', 'replyText', 'text', 'response'] as const;
  for (const field of replyFields) {
    if (value[field] !== undefined && typeof value[field] !== 'string') return undefined;
  }
  const reply = replyFields
    .map((field) => value[field])
    .find(
      (candidate): candidate is string =>
        typeof candidate === 'string' && candidate.trim().length > 0
    )
    ?.trim();
  if (!reply) return undefined;

  let intentResolution: IntentResolutionContract | undefined;
  if (value.intentResolution !== undefined) {
    intentResolution = parseIntentResolutionContract(value.intentResolution);
    if (!intentResolution) return undefined;
  }
  return { reply, ...(intentResolution ? { intentResolution } : {}) };
}

/** FD-03: exactly the keys the ask page renders (`GET /api/ask-vocabulary`).
 * Mixes the `front_desk` domain with the shared `tui` authority/outcome labels.
 * Used by: Studio (`front-desk-routes.ts`), Concierge (`/api/ask-vocabulary`). */
export const ASK_VOCABULARY_KEYS = [
  'front_desk:hearing_conflict_stale_snapshot',
  'front_desk:hearing_conflict_completion_locked',
  'front_desk:hearing_conflict_handoff_unresolved',
  'front_desk:hearing_decision_pending',
  'front_desk:hearing_decision_unknown',
  'front_desk:hearing_decision_storage',
  'front_desk:hearing_decision_rejected',
  'front_desk:hearing_decision_check',
  'front_desk:hearing_decision_checking',
  'front_desk:hearing_decision_recovered',
  'front_desk:hearing_decision_superseded',
  'front_desk:hearing_decision_legacy',
  'front_desk:hearing_decision_scope',
  'front_desk:hearing_decision_continue',
  'front_desk:hearing_sync_pending',
  'front_desk:hearing_sync_unconfirmed',
  'front_desk:hearing_sync_storage',
  'front_desk:hearing_sync_scope',
  'front_desk:hearing_sync_retry',
  'front_desk:hearing_sync_continue',
  'front_desk:ask_home_draft_preserved',
  'front_desk:ask_pending_send_blocked',
  'front_desk:ask_pending_review_description',
  'front_desk:ask_pending_review',
  'front_desk:ask_keyboard_hint',
  'front_desk:ask_draft_too_long',
  'front_desk:work_home_resume_readonly',
  'front_desk:work_home_request_unavailable',
  'front_desk:conversation_access_required',
  'front_desk:conversation_storage_required',
  'front_desk:conversation_scope_selection_required',
  'front_desk:conversation_not_started',
  'front_desk:conversation_capability_unsupported',
  'concierge:dock.history.loading',
  'concierge:dock.history.failed',
  'concierge:dock.history.retry',
  'concierge:dock.history.pending',
  'concierge:dock.history.unsaved',
  'concierge:api.history_unavailable',
  'front_desk:nav_settings',
  'front_desk:nav_progress',
  'front_desk:conversation_legacy_history',
  'front_desk:conversation_legacy_notice',
  'front_desk:home_ask_placeholder',
  'front_desk:home_ask_send',
  'front_desk:home_ask_voice',
  'front_desk:ask_placeholder_followup',
  'front_desk:ask_about_title',
  'front_desk:ask_understood',
  'front_desk:ask_state',
  'front_desk:ask_decision_point',
  'front_desk:ask_deliverable',
  'front_desk:ask_recent',
  'front_desk:ask_recent_loading',
  'front_desk:ask_recent_failed',
  'front_desk:ask_recent_retry',
  'front_desk:ask_handsfree_on',
  'front_desk:ask_handsfree_off',
  'front_desk:ask_listening',
  'front_desk:ask_thinking',
  'front_desk:ask_proceed',
  'front_desk:ask_more_detail',
  'front_desk:ask_action_input',
  'front_desk:ask_action_review',
  'front_desk:ask_action_manual',
  'front_desk:ask_action_reference',
  'front_desk:ask_action_guidance',
  'front_desk:ask_action_missing',
  'front_desk:ask_action_consequence',
  'front_desk:ask_action_reply',
  'front_desk:ask_action_review_prompt',
  'front_desk:ask_action_draft_intro',
  'front_desk:ask_empty',
  'front_desk:ask_today',
  'front_desk:ask_original_request',
  'front_desk:ask_voice_settings',
  'front_desk:ask_send_failed',
  'front_desk:chip_email',
  'front_desk:chip_minutes',
  'front_desk:chip_browser',
  'front_desk:chip_webapp',
  'front_desk:chip_process',
  'front_desk:count_items',
  // FD-09: `resolution_shape` labels for the "Current state" block —
  // `front_desk`-domain plain wording (see `ASK_SHAPE_LABEL_KEY` in
  // `ask-view.ts` for why this does not reuse the existing
  // `tui:tui_cockpit_shape_*` keys).
  'front_desk:shape_direct_answer',
  'front_desk:shape_task_session',
  'front_desk:shape_mission',
  'front_desk:shape_project_bootstrap',
  // FD-09: the UX-contract conversation-turn shape chip (`AskConversationShape`
  // in `ask-view.ts`), rendered through vocabulary instead of the raw
  // internal shape id.
  'front_desk:shape_chip_clarification',
  'front_desk:shape_chip_execution_preview',
  'front_desk:shape_chip_status_summary',
  'front_desk:shape_chip_delivery_summary',
  'front_desk:shape_chip_reply',
  'tui:tui_cockpit_authority_autonomous',
  'tui:tui_cockpit_authority_approval',
  'tui:tui_cockpit_authority_clarification',
  'tui:tui_cockpit_outcome_answer',
  'tui:tui_cockpit_outcome_artifact',
  'tui:tui_cockpit_outcome_approval_ready_plan',
  'tui:tui_cockpit_outcome_service_change',
  'tui:tui_cockpit_outcome_status_report',
  // HT-06: the `/ask?mode=hearing` card (`hearing-card` in `ask.html`) —
  // requirement labels themselves come from the hearing record's own
  // per-locale `label` (resolved server-side from `label_key`), never from
  // this fixed-chrome list.
  'front_desk:hearing_title',
  'front_desk:hearing_coverage',
  'front_desk:hearing_decide',
  'front_desk:hearing_pending',
  'front_desk:hearing_canvas_frame_title',
  // HT-02: one-line canvas generation status under the `#hearing-canvas`
  // iframe, driven by the hearing record's `canvas_generation` field
  // (`'pending' | 'generated' | 'template'`, absent on old records treated
  // as `template`).
  'front_desk:hearing_canvas_updating',
  'front_desk:hearing_canvas_generated',
  'front_desk:hearing_canvas_template',
  // SD-05: a ledger hearing's canvas is a deterministic projection of the
  // tenant's decision ledger (`canvas_generation: 'projected'`).
  'front_desk:hearing_canvas_projected',
  // Phase-structured hearing sheets: current phase line above the canvas.
  'front_desk:hearing_phase_progress',
  // HT-03 (2nd half): the "confirm and hand off as a request" action on the
  // decided hearing card, and its result — `POST /api/hearing/:session/handoff`.
  'front_desk:hearing_handoff_button',
  'front_desk:hearing_handoff_pending',
  'front_desk:hearing_handoff_done',
  'front_desk:hearing_handoff_failed',
  'front_desk:hearing_completion_unavailable',
  'front_desk:hearing_mission_label',
  'front_desk:hearing_open_decide',
  // WI-08: the "save to the work inventory" confirm action for the
  // `work_inventory` hearing scenario (`handoff: 'work_inventory'` in
  // `hearing-scenarios.json`) — mirrors the `hearing_handoff_*`/
  // `hearing_open_decide` set above, which is the equivalent for the
  // `mission` handoff. The scenario's own requirement labels are resolved
  // server-side into each `record.requirements[].label` (same mechanism as
  // `web_app_build`'s `hearing_req_*` keys, also absent from this list) and
  // rendered inside the canvas iframe, never read by this client script
  // directly.
  'front_desk:hearing_inventory_button',
  'front_desk:hearing_inventory_pending',
  'front_desk:hearing_inventory_done',
  'front_desk:hearing_inventory_failed',
  'front_desk:hearing_inventory_project_unsupported',
  'front_desk:hearing_scope_unavailable',
  'front_desk:hearing_inventory_entry_label',
  'front_desk:hearing_inventory_open',
] as const satisfies readonly VocabularyKey[];

/** FD-03: `POST /api/conversation` — the 頼む conversation turn.
 * Used by: Studio (`presenceStudioConversationSchema`), Concierge `/api/conversation`. */
export const askConversationRequestSchema = z
  .object({
    text: z.string().trim().min(1, 'text is required').max(4000, 'text is too long'),
    locale: z.string().trim().min(2).max(32).optional(),
    session_id: z.string().trim().min(1).max(128).optional(),
    conversation_id: z
      .string()
      .regex(/^concierge-[a-f0-9]{64}$/)
      .optional(),
    request_id: z.string().uuid().optional(),
    request_created_at: z.number().finite().nonnegative().optional(),
    // Validated with the shared exact revision parser in the authenticated route.
    artifactRevision: z.unknown().optional(),
    organizationId: z.string().trim().min(1).max(128).optional(),
    projectId: z.string().trim().min(1).max(128).optional(),
    tenant: z.string().trim().min(1).max(32).optional(),
  })
  .strict();

// -- Conversation navigation ------------------------------------------------
// Read-only navigation evidence. No href, execution state or authority is inferred.
// Used by: Studio and Concierge `/api/conversation`.
export interface ConversationNavigation {
  kind: 'request' | 'progress';
  id: string;
}
export interface NavigationSession {
  session_id: string;
  correlation_id?: string;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/;
/** Sessions must already be permission-filtered by the caller. */
export function projectConversationNavigation(
  history: ConversationHistory,
  sessions: NavigationSession[]
) {
  const retained = new Set(history.messages.filter((m) => m.role === 'user').map((m) => m.id));
  const byRequest = new Map<string, string[]>();
  for (const session of sessions) {
    if (
      !session.correlation_id ||
      !UUID.test(session.correlation_id) ||
      !SESSION_ID.test(session.session_id)
    )
      continue;
    const ids = byRequest.get(session.correlation_id) ?? [];
    if (!ids.includes(session.session_id)) ids.push(session.session_id);
    byRequest.set(session.correlation_id, ids);
  }
  return {
    ...history,
    messages: history.messages.map((message) => {
      const navigation: ConversationNavigation[] = [];
      if (message.role === 'user' && message.id.endsWith('-user')) {
        const ownId = message.id.slice(0, -5);
        if (UUID.test(ownId)) {
          const refs = [...new Set([ownId, ...(message.requestRefs ?? [])])];
          for (const id of refs) {
            if (!UUID.test(id)) continue;
            const matches = byRequest.get(id) ?? [];
            if (matches.length) {
              for (const sessionId of matches) navigation.push({ kind: 'progress', id: sessionId });
            } else if (id !== ownId && retained.has(id + '-user')) {
              navigation.push({ kind: 'request', id });
            }
          }
        }
      }
      return { ...message, ...(navigation.length ? { navigation: navigation.slice(0, 64) } : {}) };
    }),
  };
}
