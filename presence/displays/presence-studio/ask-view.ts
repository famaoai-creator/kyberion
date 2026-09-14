/**
 * ask-view.ts — FD-03: the pure `IntentResolutionContract -> { shape,
 * next_actions }` mapping for the presence-studio "頼む" (ask) page. See
 * `docs/developer/improvement-plans-2026-08/FRONT_DESK_REDESIGN_PLAN_2026-09-13.ja.md`
 * §2.1 / FD-03 and `docs/USER_EXPERIENCE_CONTRACT.md` (Clarification /
 * Execution Preview / Status Summary / Delivery Summary).
 *
 * This is a from-scratch, Node-side port of the concierge's
 * `viewFromIntentResolution` (`presence/displays/concierge/src/app/api/message/route.ts`)
 * — not an import, because `presence/displays/concierge/**` is out of scope
 * for this task (a sibling agent owns it) and this surface is plain
 * server-side Express + a static browser page rather than Next.js.
 *
 * Only what `IntentResolutionContract.authority_level` actually distinguishes
 * is claimed:
 * - `human_clarification_required` -> Clarification, with a `more_detail`
 *   next action.
 * - `approval_required` -> Execution Preview, with a `proceed` next action.
 * - `autonomous` -> a plain reply (the "About this request" panel still
 *   renders the four blocks from the contract; there is just no extra
 *   next-action row under the conversation turn).
 *
 * The `proceed` / `more_detail` ids are a deliberate simplification for this
 * surface's two generic quick-reply chips (`front_desk:ask_proceed` /
 * `front_desk:ask_more_detail`) — `static/ask.js` renders those two
 * localized labels (not the contract's own `next_action.label`) whenever it
 * sees these ids, and falls back to rendering the API-returned label
 * verbatim for any other id/shape (there are none from this function today,
 * but `AskNextAction.id` stays a plain `string` so a future caller can add
 * one without a type change here).
 */
import { isRecord } from '@agent/core/foundation/primitives';
import {
  parseIntentResolutionContract,
  type IntentResolutionContract,
  type IntentResolutionShape,
} from '@agent/core/intent-resolution-contract-parser';
import type { VocabularyKey } from '@agent/core/t';

export type AskConversationShape =
  'clarification' | 'execution_preview' | 'status_summary' | 'delivery_summary' | 'reply';

/**
 * FD-09: `resolution_shape` -> a `front_desk` vocabulary key with plain
 * front-desk wording. Deliberately does *not* reuse the existing
 * `tui:tui_cockpit_shape_*` keys (`knowledge/product/orchestration/user-facing-vocabulary.json`)
 * even though those already cover all four `IntentResolutionShape` values:
 * their English text for `mission` is the literal word "mission", which
 * `docs/developer/improvement-plans-2026-08/FRONT_DESK_REDESIGN_PLAN_2026-09-13.ja.md`
 * §0 item 2 explicitly bans from the front-desk human surfaces (`front-desk-routes.test.ts`
 * enforces this at the source-file level for `static/ask.js`). Declared as
 * an exhaustive `Record` over `IntentResolutionShape` so a new enum member
 * fails `tsc` here before it can render as a raw internal id in
 * `static/ask.js`, which mirrors this exact map as `SHAPE_LABEL_KEY` (a
 * plain browser script cannot import this module — see its own module doc).
 */
export const ASK_SHAPE_LABEL_KEY: Record<IntentResolutionShape, VocabularyKey> = {
  direct_answer: 'front_desk:shape_direct_answer',
  task_session: 'front_desk:shape_task_session',
  mission: 'front_desk:shape_mission',
  project_bootstrap: 'front_desk:shape_project_bootstrap',
};

export interface AskNextAction {
  id: string;
  /** Human-readable label from the contract's own `next_action.label` — kept
   * for API completeness even though `proceed` / `more_detail` are re-labeled
   * client-side (see module doc). */
  label: string;
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
 * the caller (`server.ts`) passes in whatever catalog lookup it already
 * built from `loadStandardIntentCatalog()` so this module stays I/O-free.
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

export function viewFromIntentResolution(contract: IntentResolutionContract): AskConversationView {
  if (contract.authority_level === 'human_clarification_required') {
    return {
      shape: 'clarification',
      nextActions: [{ id: 'more_detail', label: contract.next_action.label }],
    };
  }
  if (contract.authority_level === 'approval_required') {
    return {
      shape: 'execution_preview',
      nextActions: [{ id: 'proceed', label: contract.next_action.label }],
    };
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
