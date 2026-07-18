import * as path from 'node:path';
import { homedir } from 'node:os';
import { safeExec } from './secure-io.js';
import { logger } from './core.js';

export interface IMessageAttachment {
  id: string;
  filename?: string;
  mimeType?: string;
  uti?: string;
  path?: string;
  size?: number;
}

export type IMessageTapbackKind =
  | 'love'
  | 'like'
  | 'dislike'
  | 'laugh'
  | 'emphasize'
  | 'question'
  | 'remove'
  | 'unknown';

export interface IMessageTapback {
  kind: IMessageTapbackKind;
  typeCode: number;
  targetGuid?: string;
}

export interface IMessageStimulus {
  id: string;
  sender: string;
  text: string;
  date: string;
  isFromMe: boolean;
  chatId: string;
  chatGuid: string;
  isGroup?: boolean;
  attachments?: IMessageAttachment[];
  tapback?: IMessageTapback;
}

const IMESSAGE_DATABASE_PATH = path.join(homedir(), 'Library', 'Messages', 'chat.db');
const DEFAULT_DIFFERENTIAL_LIMIT = 200;

export const DEFAULT_IMESSAGE_WAKE_WORD = 'Kyberion';

const IMESSAGE_TAPBACK_TYPES: Record<number, IMessageTapbackKind> = {
  2000: 'love',
  2001: 'like',
  2002: 'dislike',
  2003: 'laugh',
  2004: 'emphasize',
  2005: 'question',
  3000: 'remove',
};

/** Normalize Messages.app associated-message reactions without payload bytes. */
export function normalizeIMessageTapback(
  rawType: unknown,
  targetGuid?: unknown
): IMessageTapback | undefined {
  const typeCode = Number(rawType);
  if (!Number.isInteger(typeCode) || typeCode === 0) return undefined;
  const target = String(targetGuid || '').trim();
  return {
    kind: IMESSAGE_TAPBACK_TYPES[typeCode] || 'unknown',
    typeCode,
    ...(target ? { targetGuid: target } : {}),
  };
}

export function formatIMessageTapbackSummary(tapback?: IMessageTapback): string {
  if (!tapback) return '';
  const target = tapback.targetGuid ? ` on ${tapback.targetGuid}` : '';
  return `Received iMessage tapback: ${tapback.kind}${target}`;
}

/** Normalize imsg/BlueBubbles-style attachment payloads without reading files. */
export function normalizeIMessageAttachments(raw: unknown): IMessageAttachment[] {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        return normalizeIMessageAttachments(JSON.parse(trimmed));
      } catch {
        // Treat a non-JSON string as a filename below.
      }
    }
    return [
      {
        id: `attachment-${trimmed}`,
        filename: trimmed,
        ...(path.isAbsolute(trimmed) ? { path: trimmed } : {}),
      },
    ];
  }

  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined;
  const values = Array.isArray(raw)
    ? raw
    : Array.isArray(record?.attachments)
      ? record.attachments
      : raw
        ? [raw]
        : [];
  return values.flatMap((value, index) => {
    if (typeof value === 'string') return normalizeIMessageAttachments(value);
    if (!value || typeof value !== 'object') return [];
    const item = value as Record<string, unknown>;
    const filename = String(
      item.filename ?? item.file_name ?? item.transferName ?? item.transfer_name ?? item.name ?? ''
    ).trim();
    const mimeType = String(
      item.mimeType ?? item.mime_type ?? item.mime ?? item.content_type ?? ''
    ).trim();
    const uti = String(item.uti ?? item.uniform_type_identifier ?? '').trim();
    const attachmentPath = String(item.path ?? item.file_path ?? '').trim();
    const resolvedAttachmentPath = attachmentPath || (path.isAbsolute(filename) ? filename : '');
    const size = Number(item.size ?? item.file_size);
    if (!filename && !mimeType && !uti && !attachmentPath) return [];
    return [
      {
        id: String(item.id ?? item.guid ?? `attachment-${index}`),
        ...(filename ? { filename } : {}),
        ...(mimeType ? { mimeType } : {}),
        ...(uti ? { uti } : {}),
        ...(resolvedAttachmentPath ? { path: resolvedAttachmentPath } : {}),
        ...(Number.isFinite(size) && size >= 0 ? { size } : {}),
      },
    ];
  });
}

export function formatIMessageAttachmentSummary(attachments: IMessageAttachment[] = []): string {
  if (attachments.length === 0) return '';
  return [
    'Received iMessage attachments:',
    ...attachments.map((attachment) => {
      const label = path.basename(attachment.filename || attachment.path || attachment.id);
      const detail = [
        attachment.mimeType,
        attachment.uti,
        attachment.size !== undefined ? `${attachment.size} bytes` : '',
      ]
        .filter(Boolean)
        .join(', ');
      return `- ${label}${detail ? ` (${detail})` : ''}`;
    }),
  ].join('\n');
}

function parseBooleanFlag(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  if (value.trim().toLowerCase() === 'true') return true;
  if (value.trim().toLowerCase() === 'false') return false;
  return undefined;
}

/** Infer group status from the several shapes emitted by imsg versions. */
export function inferIMessageGroup(chat: Record<string, unknown>): boolean {
  const explicit = parseBooleanFlag(chat.is_group ?? chat.isGroup ?? chat.group);
  if (explicit !== undefined) return explicit;
  const participants = chat.participants ?? chat.members;
  return Array.isArray(participants) && participants.length > 1;
}

export function resolveIMessageWakeWord(value = process.env.KYBERION_IMESSAGE_WAKE_WORD): string {
  return String(value || DEFAULT_IMESSAGE_WAKE_WORD).trim() || DEFAULT_IMESSAGE_WAKE_WORD;
}

export function containsIMessageWakeWord(
  text: string,
  wakeWord = resolveIMessageWakeWord()
): boolean {
  const needle = wakeWord.trim();
  return Boolean(needle) && text.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
}

/** Remove only a leading wake word; mentions in the body remain user content. */
export function stripLeadingIMessageWakeWord(
  text: string,
  wakeWord = resolveIMessageWakeWord()
): string {
  const needle = wakeWord.trim();
  if (!needle) return text.trim();
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prefix = new RegExp(`^\\s*${escaped}(?:\\s*[,、:：!！-]?\\s*|$)`, 'iu');
  return text.replace(prefix, '').trim();
}

export function shouldProcessIMessage(
  message: Pick<IMessageStimulus, 'text' | 'isGroup' | 'tapback'>,
  wakeWord = resolveIMessageWakeWord()
): boolean {
  // A reaction is an acknowledgement of an existing message, not a new task.
  // Do not spend a model turn replying to a tapback (especially in 1:1 chats).
  if (message.tapback) return false;
  return !message.isGroup || containsIMessageWakeWord(message.text, wakeWord);
}

/**
 * imsg chats --json を使用して、最近のチャット一覧を取得する
 */
export function listIMessageChats(): any[] {
  try {
    const output = safeExec('imsg', ['chats', '--json'], {});
    const lines = String(output).trim().split('\n');
    return lines.filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
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
    const output = safeExec(
      'imsg',
      ['history', '--chat-id', chatId, '--limit', String(limit), '--attachments', '--json'],
      {}
    );
    const lines = String(output).trim().split('\n');
    return lines
      .filter((l) => l.trim() !== '')
      .map((l) => {
        const msg = JSON.parse(l);
        const attachments = normalizeIMessageAttachments(msg.attachments ?? msg.attachment);
        const tapback = normalizeIMessageTapback(
          msg.associated_message_type,
          msg.associated_message_guid
        );
        return {
          id: String(msg.id),
          sender: msg.sender || 'unknown',
          text: msg.text || '',
          date: msg.created_at,
          isFromMe: Boolean(msg.is_from_me),
          chatId: msg.chat_identifier || chatId,
          chatGuid: msg.chat_guid || '',
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(tapback ? { tapback } : {}),
        };
      });
  } catch (err) {
    logger.error(`Failed to get iMessage history for chat ${chatId} via imsg: ${err}`);
    return [];
  }
}

/**
 * Build the single-query differential poll used on macOS.
 *
 * Messages.app stores message dates as seconds or nanoseconds since the
 * 2001-01-01 Apple epoch depending on the OS version, so the query handles
 * both forms. The query deliberately uses ROWID as the cursor: it is local,
 * monotonic, and avoids a per-chat cursor map.
 */
export function buildIMessageDifferentialQuery(
  lastSeenId: number,
  limit = DEFAULT_DIFFERENTIAL_LIMIT
): string {
  const cursor = Math.max(0, Math.floor(Number.isFinite(lastSeenId) ? lastSeenId : 0));
  const rowLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
  return `SELECT
    m.ROWID AS id,
    COALESCE(m.text, '') AS text,
    datetime(
      CASE
        WHEN m.date > 100000000000 THEN m.date / 1000000000 + 978307200
        ELSE m.date + 978307200
      END,
      'unixepoch'
    ) AS created_at,
    COALESCE(m.is_from_me, 0) AS is_from_me,
    COALESCE(h.id, '') AS sender,
    COALESCE(c.chat_identifier, c.guid, '') AS chat_identifier,
    COALESCE(c.guid, '') AS chat_guid,
    COALESCE(m.guid, '') AS guid,
    COALESCE(m.associated_message_guid, '') AS associated_message_guid,
    COALESCE(m.associated_message_type, 0) AS associated_message_type,
    COALESCE((
      SELECT group_concat(COALESCE(a.filename, a.mime, a.uti, 'attachment'), char(10))
      FROM message_attachment_join maj
      JOIN attachment a ON a.ROWID = maj.attachment_id
      WHERE maj.message_id = m.ROWID
    ), '') AS attachment_summary,
    CASE
      WHEN COALESCE(c.style, 0) > 0 THEN 1
      WHEN (SELECT COUNT(*) FROM chat_handle_join chj WHERE chj.chat_id = c.ROWID) > 1 THEN 1
      ELSE 0
    END AS is_group
  FROM message m
  JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
  JOIN chat c ON c.ROWID = cmj.chat_id
  LEFT JOIN handle h ON h.ROWID = m.handle_id
  WHERE m.ROWID > ${cursor}
  ORDER BY m.ROWID ASC
  LIMIT ${rowLimit};`;
}

function normalizeDifferentialMessage(raw: Record<string, unknown>): IMessageStimulus {
  const isGroup = parseBooleanFlag(raw.is_group) ?? Number(raw.is_group || 0) > 0;
  const attachmentSummary = String(raw.attachment_summary || '').trim();
  const attachments = attachmentSummary
    ? attachmentSummary.split(/\r?\n/u).flatMap((value) => normalizeIMessageAttachments(value))
    : [];
  const tapback = normalizeIMessageTapback(
    raw.associated_message_type,
    raw.associated_message_guid
  );
  return {
    id: String(raw.id || ''),
    sender: String(raw.sender || 'unknown'),
    text: String(raw.text || ''),
    date: String(raw.created_at || ''),
    isFromMe: Boolean(Number(raw.is_from_me || 0)),
    chatId: String(raw.chat_identifier || ''),
    chatGuid: String(raw.chat_guid || ''),
    isGroup,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(tapback ? { tapback } : {}),
  };
}

/** Return null when the local DB schema/permission is unavailable. */
function getRecentIMessagesFromDatabase(
  lastSeenId: number,
  limit: number
): IMessageStimulus[] | null {
  try {
    const output = safeExec('sqlite3', ['-json', IMESSAGE_DATABASE_PATH], {
      input: buildIMessageDifferentialQuery(lastSeenId, limit),
    });
    const parsed = JSON.parse(String(output || '[]')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((row) => normalizeDifferentialMessage(row as Record<string, unknown>))
      .filter((message) => message.id && message.chatId)
      .sort((a, b) => Number(a.id) - Number(b.id));
  } catch {
    return null;
  }
}

/**
 * 最新のメッセージを差分取得する。Messages DB が読める macOS では
 * 1 回の sqlite3 起動で取得し、DB が使えない環境では旧 imsg per-chat
 * fallback を維持する。
 */
export function getRecentIMessages(
  lastSeenId: number = 0,
  limitPerChat: number = 10
): IMessageStimulus[] {
  const differential = getRecentIMessagesFromDatabase(
    lastSeenId,
    Math.max(DEFAULT_DIFFERENTIAL_LIMIT, limitPerChat)
  );
  if (differential !== null) return differential;

  const chats = listIMessageChats();
  const allMessages: IMessageStimulus[] = [];

  for (const chat of chats) {
    if (!chat.id) continue;
    const history = getIMessageHistory(String(chat.id), limitPerChat);
    const isGroup = inferIMessageGroup(chat as Record<string, unknown>);
    // 指定されたIDより大きいものだけを抽出
    const filtered = history.filter((m) => Number(m.id) > lastSeenId);
    allMessages.push(...filtered.map((message) => ({ ...message, isGroup })));
  }

  // 日付順にソートして返す
  return allMessages.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

/**
 * 以前の直接SQLクエリ方式（互換性のために残すが imsg を優先的に使う）
 */
export function queryIMessages(sql: string): any[] {
  try {
    const output = safeExec('sqlite3', ['-json', IMESSAGE_DATABASE_PATH], { input: sql });
    const trimmed = String(output).trim();
    if (!trimmed || trimmed === '') return [];
    return JSON.parse(trimmed);
  } catch (err) {
    return [];
  }
}
