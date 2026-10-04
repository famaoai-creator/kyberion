/** Compatibility facade. The shared store deliberately retains Concierge v1 keys and paths. */
export {
  beginConversationTurn,
  reserveConversationTurn,
  completeConversationTurn,
  markConversationTurnUncertain,
  markConversationTurnNotStarted,
  completedConversationContext,
  frontDeskRuntimeScope,
  narrowFrontDeskConversationViewer,
  conversationRef,
  readConversationHistory,
  ConversationStoreError,
} from '@agent/core/surface/front-desk-conversation-store';
