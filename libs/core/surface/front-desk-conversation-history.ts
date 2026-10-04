/** Display-only history. Restoring a transcript never restores an approval action. */
export interface ConversationHistoryMessage {
  id: string;
  role: 'user' | 'secretary';
  text: string;
  createdAt?: number;
}

export interface ConversationHistory {
  sessionId: string;
  messages: ConversationHistoryMessage[];
  pending: number;
}

export const CONVERSATION_MAX_TURNS = 50;
export const CONVERSATION_MAX_INPUT = 8192;
export const CONVERSATION_MAX_REPLY = 32768;

export function parseConversationHistory(value: unknown): ConversationHistory | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.sessionId !== 'string' ||
    !/^concierge-[a-f0-9]{64}$/.test(record.sessionId) ||
    !Array.isArray(record.messages) ||
    record.messages.length > CONVERSATION_MAX_TURNS * 2 ||
    !Number.isInteger(record.pending) ||
    (record.pending as number) < 0 ||
    (record.pending as number) > CONVERSATION_MAX_TURNS
  )
    return undefined;
  const messages: ConversationHistoryMessage[] = [];
  for (const message of record.messages) {
    if (!message || typeof message !== 'object') return undefined;
    const item = message as Record<string, unknown>;
    if (
      typeof item.id !== 'string' ||
      !item.id ||
      (item.role !== 'user' && item.role !== 'secretary') ||
      typeof item.text !== 'string' ||
      !item.text ||
      item.text.length > CONVERSATION_MAX_REPLY
    )
      return undefined;
    // Explicit projection drops executable metadata even if supplied by a server.
    messages.push({
      id: item.id,
      role: item.role,
      text: item.text,
      ...(typeof item.createdAt === 'number' && Number.isFinite(item.createdAt)
        ? { createdAt: item.createdAt }
        : {}),
    });
  }
  return { sessionId: record.sessionId, messages, pending: record.pending as number };
}
