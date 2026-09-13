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
} from '@agent/core/intent-resolution-contract-parser';

export type AskConversationShape =
  'clarification' | 'execution_preview' | 'status_summary' | 'delivery_summary' | 'reply';

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
