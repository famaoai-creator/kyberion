import { safeExec } from './secure-io.js';
import { logger } from './core.js';

/**
 * iMessage attributedBody (NSAttributedString binary) からプレーンテキストを抽出する
 */
export function decodeAttributedBody(hexBody: string): string {
  if (!hexBody || hexBody === 'NULL' || hexBody === '') return '';

  const pythonScript = `
import sys
import binascii

def extract_text(hex_str):
    try:
        data = binascii.unhexlify(hex_str)
        # NSAttributedString (typedstream) の簡易パース
        # 文字列データの開始マーカーを探す
        start = data.find(b'\\x01\\x94\\x84\\x01\\x2b')
        if start != -1:
            # マーカーの直後の1バイトが長さ（簡易版）
            length = data[start+5]
            text = data[start+6 : start+6+length]
            return text.decode('utf-8', errors='ignore')
        return ""
    except Exception:
        return ""

print(extract_text(sys.argv[1]))
`;

  try {
    const result = safeExec('python3', ['-c', pythonScript, hexBody]);
    return String(result).trim();
  } catch (err) {
    return '';
  }
}

/**
 * sqlite3コマンドを使用して、JSON形式でメッセージを取得する
 */
export function queryIMessages(sql: string): any[] {
  try {
    const dbPath = '~/Library/Messages/chat.db';
    // -json フラグを使用して結果を構造化データとして受け取る
    const output = safeExec('sqlite3', ['-json', dbPath, sql]);
    const trimmed = String(output).trim();
    if (!trimmed || trimmed === '') return [];
    return JSON.parse(trimmed);
  } catch (err) {
    // 権限エラーなどの場合は空を返す
    return [];
  }
}

export interface IMessageStimulus {
  id: string;
  sender: string;
  text: string;
  date: string;
  isFromMe: boolean;
  chatId: string;
}

/**
 * 最新の未読/新着メッセージを取得する
 */
export function getRecentIMessages(lastRowId: number = 0): IMessageStimulus[] {
  const sql = `
    SELECT 
        m.ROWID as id,
        h.id as sender,
        m.text,
        hex(m.attributedBody) as hexBody,
        datetime(m.date / 1000000000 + strftime('%s', '2001-01-01'), 'unixepoch', 'localtime') as date,
        m.is_from_me as isFromMe,
        c.chat_identifier as chatId
    FROM message m
    LEFT JOIN handle h ON m.handle_id = h.ROWID
    LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
    LEFT JOIN chat c ON cmj.chat_id = c.ROWID
    WHERE m.ROWID > ${lastRowId}
    ORDER BY m.date ASC;
  `;

  const rows = queryIMessages(sql);
  return rows.map(row => ({
    id: String(row.id),
    sender: row.sender || 'unknown',
    text: (row.text && row.text !== '') ? row.text : decodeAttributedBody(row.hexBody),
    date: row.date,
    isFromMe: Boolean(row.isFromMe),
    chatId: row.chatId || 'direct',
  }));
}
