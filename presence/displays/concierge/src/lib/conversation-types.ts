import {
  parseIntentResolutionContract,
  type IntentResolutionContract,
} from '@agent/core/intent-resolution-contract-parser';
import { isRecord } from '@agent/core/foundation/primitives';

const CONVERSATION_RESPONSE_DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function hasSafeConversationTree(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(hasSafeConversationTree);
  if (!isRecord(value)) return true;
  return Object.entries(value).every(
    ([key, nested]) =>
      !CONVERSATION_RESPONSE_DANGEROUS_KEYS.has(key) && hasSafeConversationTree(nested)
  );
}

/**
 * Shared request/response contract for the concierge conversation core
 * (CS-01). Used by both the /api/message route (server) and the
 * conversation dock (client) so the two sides cannot drift apart.
 *
 * Vocabulary follows docs/USER_EXPERIENCE_CONTRACT.md: the only shapes a
 * reply may claim are the four standard conversation shapes plus a plain
 * `reply` when the orchestrator result does not distinguish one.
 */
export type ConversationShape =
  'clarification' | 'execution_preview' | 'status_summary' | 'delivery_summary' | 'reply';

export type ConversationMode = 'voice-hub' | 'orchestrator' | 'unavailable';

export interface ConversationNextAction {
  id: string;
  /** Human-readable label; the dock sends it verbatim as the next message. */
  label: string;
}

export interface ConversationPromotion {
  kind: 'mission' | 'task_session';
  label: string;
}

export interface ConversationMessageRequest {
  text: string;
  locale?: string;
  /** Optional stable thread id so follow-ups (e.g. confirmations) stay in one conversation. */
  sessionId?: string;
}

export interface ConversationMessageResponse {
  reply: string;
  mode: ConversationMode;
  shape: ConversationShape;
  promoted?: ConversationPromotion;
  nextActions?: ConversationNextAction[];
  intentResolution?: IntentResolutionContract;
}

export interface VoiceHubConversationResponse {
  reply: string;
  intentResolution?: IntentResolutionContract;
}

/** Narrow the voice-hub response before it enters the conversation surface. */
export function parseVoiceHubConversationResponse(
  value: unknown
): VoiceHubConversationResponse | undefined {
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
