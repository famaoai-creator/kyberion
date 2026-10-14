/** Read-only navigation evidence. No href, execution state or authority is inferred. */
import type { ConversationHistory } from '@agent/core/surface/front-desk-conversation-history';
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
