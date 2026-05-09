import { safeExec } from './secure-io.js';
import { logger } from './core.js';

export interface IMessageStimulus {
  id: string;
  sender: string;
  text: string;
  date: string;
  isFromMe: boolean;
  chatId: string;
  chatGuid: string;
}

/**
 * imsg chats --json を使用して、最近のチャット一覧を取得する
 */
export function listIMessageChats(): any[] {
  try {
    const output = safeExec('imsg', ['chats', '--json'], {});
    const lines = String(output).trim().split('\n');
    return lines.filter(l => l.trim() !== '').map(l => JSON.parse(l));
  } catch (err) {
    logger.error(`Failed to list iMessage chats via imsg: ${err}`);
    return [];
  }
}

/**
 * imsg history --chat-id <id> --json を使用して、特定のチャットの履歴を取得する
 */
export function getIMessageHistory(chatId: string, limit: number = 20): IMessageStimulus[] {
  try {
    const output = safeExec('imsg', ['history', '--chat-id', chatId, '--limit', String(limit), '--json'], {});
    const lines = String(output).trim().split('\n');
    return lines.filter(l => l.trim() !== '').map(l => {
      const msg = JSON.parse(l);
      return {
        id: String(msg.id),
        sender: msg.sender || 'unknown',
        text: msg.text || '',
        date: msg.created_at,
        isFromMe: Boolean(msg.is_from_me),
        chatId: msg.chat_identifier || chatId,
        chatGuid: msg.chat_guid || '',
      };
    });
  } catch (err) {
    logger.error(`Failed to get iMessage history for chat ${chatId} via imsg: ${err}`);
    return [];
  }
}

/**
 * 全てのチャットから最新のメッセージを取得し、IDでフィルタリングする
 */
export function getRecentIMessages(lastSeenId: number = 0, limitPerChat: number = 10): IMessageStimulus[] {
  const chats = listIMessageChats();
  const allMessages: IMessageStimulus[] = [];
  
  for (const chat of chats) {
    if (!chat.id) continue;
    const history = getIMessageHistory(String(chat.id), limitPerChat);
    // 指定されたIDより大きいものだけを抽出
    const filtered = history.filter(m => Number(m.id) > lastSeenId);
    allMessages.push(...filtered);
  }

  // 日付順にソートして返す
  return allMessages.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

/**
 * 以前の直接SQLクエリ方式（互換性のために残すが imsg を優先的に使う）
 */
export function queryIMessages(sql: string): any[] {
  try {
    const dbPath = '~/Library/Messages/chat.db';
    const output = safeExec('sqlite3', ['-json', dbPath, sql], {});
    const trimmed = String(output).trim();
    if (!trimmed || trimmed === '') return [];
    return JSON.parse(trimmed);
  } catch (err) {
    return [];
  }
}
