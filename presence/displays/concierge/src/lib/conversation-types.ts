import type { IntentResolutionContract } from '@agent/core';

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
