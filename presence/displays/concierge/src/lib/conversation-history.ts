/** Browser-safe shared history contract; restored turns never carry approval actions. */
export {
  CONVERSATION_MAX_TURNS,
  CONVERSATION_MAX_INPUT,
  CONVERSATION_MAX_REPLY,
  parseConversationHistory,
} from '@agent/core/surface/front-desk-conversation-history';
export type {
  ConversationHistory,
  ConversationHistoryMessage,
} from '@agent/core/surface/front-desk-conversation-history';
