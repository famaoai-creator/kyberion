import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeWriteFile } from './secure-io.js';
import { logger } from './core.js';
import { findMissionPath } from './path-resolver.js';

export interface ConversationTurn {
  ts: string; // ISO timestamp
  sender: string;
  receiver: string;
  performative: string;
  prompt?: string; // Omitted if confidential/personal context
  result?: string; // Omitted if confidential/personal context
  provider_session_id?: string;
}

const MAX_TURNS = 500;

function sanitizeConversationId(conversationId: string): string {
  const value = conversationId.trim();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
    throw new Error('Invalid conversation_id');
  }
  return value;
}

function resolveConversationFilePath(conversationId: string): string {
  const safeConversationId = sanitizeConversationId(conversationId);
  const conversationsDir = path.resolve(pathResolver.shared('runtime/a2a-conversations'));
  const filePath = path.resolve(conversationsDir, `${safeConversationId}.jsonl`);
  if (!filePath.startsWith(`${conversationsDir}${path.sep}`)) {
    throw new Error('Invalid conversation path');
  }
  return filePath;
}

/**
 * Checks if a mission has confidential or personal tier constraints.
 */
export function isConfidentialMission(missionId: string | undefined): boolean {
  if (!missionId) return false;
  const missionPath = findMissionPath(missionId);
  if (!missionPath) return false;
  const lower = missionPath.toLowerCase();
  return lower.includes('/confidential/') || lower.includes('/personal/');
}

/**
 * Appends a conversation turn to the thread history file, enforcing limits and confidentiality.
 */
export async function appendConversationTurn(
  conversationId: string,
  turnData: Omit<ConversationTurn, 'ts'> & { missionId?: string }
): Promise<void> {
  if (!conversationId) return;

  const filePath = resolveConversationFilePath(conversationId);

  const isConfidential = isConfidentialMission(turnData.missionId);

  const turn: ConversationTurn = {
    ts: new Date().toISOString(),
    sender: turnData.sender,
    receiver: turnData.receiver,
    performative: turnData.performative,
    prompt: isConfidential ? undefined : turnData.prompt?.slice(0, 200),
    result: isConfidential ? undefined : turnData.result?.slice(0, 200),
    provider_session_id: turnData.provider_session_id,
  };

  let lines: string[] = [];
  if (safeExistsSync(filePath)) {
    try {
      const content = safeReadFile(filePath, { encoding: 'utf8' }) as string;
      lines = content.split('\n').filter((l) => l.trim().length > 0);
    } catch (err: any) {
      logger.warn(
        `[A2A_CONVERSATION_STORE] Failed to read conversation file ${filePath}: ${err?.message}`
      );
    }
  }

  lines.push(JSON.stringify(turn));

  if (lines.length > MAX_TURNS) {
    lines = lines.slice(-MAX_TURNS);
  }

  try {
    safeWriteFile(filePath, lines.join('\n') + '\n');
  } catch (err: any) {
    logger.warn(
      `[A2A_CONVERSATION_STORE] Failed to write conversation file ${filePath}: ${err?.message}`
    );
  }
}

/**
 * Reads the last turns for a given conversation thread.
 */
export function readConversationHistory(conversationId: string): ConversationTurn[] {
  if (!conversationId) return [];
  const filePath = resolveConversationFilePath(conversationId);

  if (!safeExistsSync(filePath)) return [];

  try {
    const content = safeReadFile(filePath, { encoding: 'utf8' }) as string;
    return content
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
  } catch (err: any) {
    logger.warn(
      `[A2A_CONVERSATION_STORE] Failed to read conversation file ${filePath}: ${err?.message}`
    );
    return [];
  }
}

/**
 * Generates a rehydration prompt prefix from the last 10 turns of conversation history.
 */
export function rehydrateConversation(conversationId: string): string {
  const history = readConversationHistory(conversationId);
  if (history.length === 0) return '';

  const lastTurns = history.slice(-10);
  let prefix = `=== A2A CONVERSATION HISTORY REHYDRATION (Last ${lastTurns.length} turns) ===\n`;
  for (const turn of lastTurns) {
    prefix += `[${turn.ts}] ${turn.sender} -> ${turn.receiver} (${turn.performative}):\n`;
    if (turn.prompt) {
      prefix += `Prompt: ${turn.prompt}\n`;
    }
    if (turn.result) {
      prefix += `Result: ${turn.result}\n`;
    }
    prefix += `\n`;
  }
  prefix += `=== END OF REHYDRATION HISTORY ===\n\n`;
  return prefix;
}
