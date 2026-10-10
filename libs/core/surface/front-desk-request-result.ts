/** Transport-neutral, read-only request result. A reply is not execution completion. */
import {
  asStore,
  conversationRef,
  load,
  type FrontDeskConversationViewer,
} from './front-desk-conversation-persistence.js';
import {
  projectConversationHistory,
  readFrontDeskConversationWork,
  readFrontDeskConversationArtifact,
  ConversationStoreError,
  type FrontDeskConversationWorkTask,
} from './front-desk-conversation-store.js';

export interface FrontDeskRequestSnapshot {
  requestId: string;
  sessionId: string;
  /** Only the conversation turn's durable response, never the delegated job state. */
  replyStatus: 'answered' | 'pending' | 'uncertain' | 'not_started';
  reply?: string;
  /** Separately verified current task state; may be empty for an ordinary reply. */
  work: FrontDeskConversationWorkTask[];
}

/**
 * Callers authenticate and authorize the viewer before entering this use case.
 * An ID never selects an owner. No locks, publication, intake or approval replay.
 * Read the exact turn ID, including follow-up/status turns that are not task IDs.
 */
export function readFrontDeskRequest(
  viewer: FrontDeskConversationViewer,
  requestId: string
): FrontDeskRequestSnapshot | undefined {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(requestId))
    throw new ConversationStoreError('invalid_history');
  const ref = conversationRef(viewer);
  return asStore(viewer, () => {
    const transcript = load(ref);
    const turn = transcript.turns.find((entry) => entry.id === requestId);
    if (!turn) return undefined;
    const taskIds = new Set(turn.routing?.taskIds ?? []);
    // A bounded history window must not hide a retained exact-turn result.
    const selected = {
      ...transcript,
      turns: [turn],
      executionRequests: transcript.executionRequests?.filter((request) =>
        taskIds.has(request.binding.request_id)
      ),
    };
    const reply = projectConversationHistory(viewer, selected, true).messages.find(
      (message) => message.id === `${requestId}-secretary`
    )?.text;
    return {
      requestId: turn.id,
      sessionId: ref.sessionId,
      replyStatus:
        turn.reply !== undefined
          ? 'answered'
          : turn.uncertain
            ? 'uncertain'
            : turn.retryable
              ? 'not_started'
              : 'pending',
      ...(reply !== undefined ? { reply } : {}),
      work: taskIds.size
        ? readFrontDeskConversationWork(viewer).tasks.filter((task) => taskIds.has(task.id))
        : [],
    };
  });
}

/** The existing artifact service validates request/revision/hash and fresh bytes. */
export const readFrontDeskRequestArtifact = readFrontDeskConversationArtifact;
