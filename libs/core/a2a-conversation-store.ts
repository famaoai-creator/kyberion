import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { parseSafeJsonInput } from './foundation/json.js';
import { isRecord, readTextFile } from './foundation/text.js';
import { nowIso } from './foundation/time.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat, safeWriteFile } from './secure-io.js';
import { logger } from './core.js';
import { findMissionPath } from './path-resolver.js';
import { Semaphore } from './semaphore.js';

export interface ConversationTurn {
  ts: string; // ISO timestamp
  sender: string;
  receiver: string;
  performative: string;
  prompt?: string; // Omitted if confidential/personal context
  result?: string; // Omitted if confidential/personal context
  provider_session_id?: string;
  /** Explicit mission binding for governed tier-scoped history collection. */
  mission_id?: string;
  tier?: 'public' | 'confidential' | 'personal';
}

const MAX_TURNS = 500;
const conversationLocks = new Map<string, Semaphore>();
const JSON_DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSafeJsonTree(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(isSafeJsonTree);
  if (value === null || typeof value !== 'object') return true;
  return Object.entries(value).every(
    ([key, nested]) => !JSON_DANGEROUS_KEYS.has(key) && isSafeJsonTree(nested)
  );
}

function parseConversationTurn(value: unknown): ConversationTurn | undefined {
  if (!isRecord(value) || !isSafeJsonTree(value)) return undefined;
  const ts = value.ts;
  const sender = value.sender;
  const receiver = value.receiver;
  const performative = value.performative;
  const prompt = value.prompt;
  const result = value.result;
  const providerSessionId = value.provider_session_id;
  const missionId = value.mission_id;
  const tier = value.tier;
  if (
    typeof ts !== 'string' ||
    Number.isNaN(Date.parse(ts)) ||
    typeof sender !== 'string' ||
    !sender.trim() ||
    typeof receiver !== 'string' ||
    !receiver.trim() ||
    typeof performative !== 'string' ||
    !performative.trim()
  ) {
    return undefined;
  }
  if (
    (prompt !== undefined && typeof prompt !== 'string') ||
    (result !== undefined && typeof result !== 'string') ||
    (providerSessionId !== undefined && typeof providerSessionId !== 'string') ||
    (missionId !== undefined && typeof missionId !== 'string') ||
    (tier !== undefined && tier !== 'public' && tier !== 'confidential' && tier !== 'personal')
  ) {
    return undefined;
  }
  const promptValue = typeof prompt === 'string' ? prompt : undefined;
  const resultValue = typeof result === 'string' ? result : undefined;
  const providerSessionIdValue =
    typeof providerSessionId === 'string' ? providerSessionId : undefined;
  const missionIdValue = typeof missionId === 'string' ? missionId : undefined;
  const tierValue: ConversationTurn['tier'] | undefined =
    tier === 'public' || tier === 'confidential' || tier === 'personal' ? tier : undefined;
  return {
    ts,
    sender,
    receiver,
    performative,
    ...(promptValue !== undefined ? { prompt: promptValue } : {}),
    ...(resultValue !== undefined ? { result: resultValue } : {}),
    ...(providerSessionIdValue !== undefined
      ? { provider_session_id: providerSessionIdValue }
      : {}),
    ...(missionIdValue !== undefined ? { mission_id: missionIdValue } : {}),
    ...(tierValue !== undefined ? { tier: tierValue } : {}),
  };
}

function parseConversationTurnLine(line: string): ConversationTurn | undefined {
  try {
    return parseConversationTurn(parseSafeJsonInput(line, 'A2A conversation entry'));
  } catch {
    return undefined;
  }
}

function getConversationLock(conversationId: string): Semaphore {
  let lock = conversationLocks.get(conversationId);
  if (!lock) {
    lock = new Semaphore(1);
    conversationLocks.set(conversationId, lock);
  }
  return lock;
}

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
  return assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
}

function assertRegularConversationFile(filePath: string): void {
  if (safeExistsSync(filePath) && !safeLstat(filePath).isFile()) {
    throw new Error(
      `[A2A_CONVERSATION_STORE] conversation file must be a regular file: ${filePath}`
    );
  }
}

function resolveMissionTier(
  missionId: string | undefined
): 'public' | 'confidential' | 'personal' | undefined {
  if (!missionId) return undefined;
  const missionPath = findMissionPath(missionId)?.toLowerCase() || '';
  const match = missionPath.match(/\/(public|confidential|personal)\//u);
  return match?.[1] as 'public' | 'confidential' | 'personal' | undefined;
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
  const lock = getConversationLock(conversationId);

  await lock.run(async () => {
    const isConfidential = isConfidentialMission(turnData.missionId);
    const tier = resolveMissionTier(turnData.missionId);

    const turn: ConversationTurn = {
      ts: nowIso(),
      sender: turnData.sender,
      receiver: turnData.receiver,
      performative: turnData.performative,
      prompt: isConfidential ? undefined : turnData.prompt?.slice(0, 200),
      result: isConfidential ? undefined : turnData.result?.slice(0, 200),
      provider_session_id: turnData.provider_session_id,
      ...(turnData.missionId ? { mission_id: turnData.missionId } : {}),
      ...(tier ? { tier } : {}),
    };

    let lines: string[] = [];
    if (safeExistsSync(filePath)) {
      assertRegularConversationFile(filePath);
      try {
        const content = readTextFile(filePath);
        lines = content.split('\n').filter((l) => l.trim().length > 0);
      } catch (err: unknown) {
        logger.warn(
          `[A2A_CONVERSATION_STORE] Failed to read conversation file ${filePath}: ${errorMessage(err)}`
        );
      }
    }

    lines.push(JSON.stringify(turn));

    if (lines.length > MAX_TURNS) {
      lines = lines.slice(-MAX_TURNS);
    }

    try {
      safeWriteFile(filePath, lines.join('\n') + '\n');
    } catch (err: unknown) {
      logger.warn(
        `[A2A_CONVERSATION_STORE] Failed to write conversation file ${filePath}: ${errorMessage(err)}`
      );
    }
  });
}

/**
 * Reads the last turns for a given conversation thread.
 */
export function readConversationHistory(conversationId: string): ConversationTurn[] {
  if (!conversationId) return [];
  const filePath = resolveConversationFilePath(conversationId);

  if (!safeExistsSync(filePath)) return [];
  assertRegularConversationFile(filePath);

  try {
    const content = readTextFile(filePath);
    return content
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map(parseConversationTurnLine)
      .filter((turn): turn is ConversationTurn => turn !== undefined);
  } catch (err: unknown) {
    logger.warn(
      `[A2A_CONVERSATION_STORE] Failed to read conversation file ${filePath}: ${errorMessage(err)}`
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
