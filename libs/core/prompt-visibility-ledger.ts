import { appendJsonLine } from './foundation/json.js';
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { assertModuleInvariant } from './invariants.js';
import { safeExistsSync, safeMkdir, safeReadFile } from './secure-io.js';

export const PROMPT_VISIBILITY_LEDGER_VERSION = 1 as const;

export interface PromptVisibilityRecord {
  version: typeof PROMPT_VISIBILITY_LEDGER_VERSION;
  record_id: string;
  ts: string;
  mission_id: string;
  source: string;
  form: string;
  content_hash: string;
  content_length: number;
  context_pack_id?: string;
  task_id?: string;
  knowledge_refs: string[];
}

export interface AppendPromptVisibilityRecordInput {
  missionPath: string;
  missionId: string;
  source: string;
  form: string;
  content: string;
  contextPackId?: string;
  taskId?: string;
  knowledgeRefs?: string[];
  ledgerPath?: string;
  now?: string;
}

function required(label: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`[PROMPT_VISIBILITY_INVALID] ${label} is required`);
  return normalized;
}

function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function ledgerFile(input: AppendPromptVisibilityRecordInput): string {
  return (
    input.ledgerPath || path.join(input.missionPath, 'coordination', 'prompt-visibility.jsonl')
  );
}

function assertRecordShape(record: PromptVisibilityRecord): void {
  assertModuleInvariant('prompt-visibility-ledger', 'record-shape', record);
}

export function appendPromptVisibilityRecord(
  input: AppendPromptVisibilityRecordInput
): PromptVisibilityRecord {
  const missionId = required('missionId', input.missionId);
  const source = required('source', input.source);
  const form = required('form', input.form);
  const file = ledgerFile(input);
  const record: PromptVisibilityRecord = {
    version: PROMPT_VISIBILITY_LEDGER_VERSION,
    record_id: `PVR-${randomUUID()}`,
    ts: input.now || new Date().toISOString(),
    mission_id: missionId,
    source,
    form,
    content_hash: contentHash(input.content),
    content_length: input.content.length,
    ...(input.contextPackId ? { context_pack_id: input.contextPackId } : {}),
    ...(input.taskId ? { task_id: input.taskId } : {}),
    knowledge_refs: [
      ...new Set((input.knowledgeRefs || []).map((ref) => ref.trim()).filter(Boolean)),
    ],
  };
  assertRecordShape(record);
  safeMkdir(path.dirname(file), { recursive: true });
  appendJsonLine(file, record);
  return record;
}

export function loadPromptVisibilityLedger(ledgerPath: string): PromptVisibilityRecord[] {
  if (!safeExistsSync(ledgerPath)) return [];
  const raw = String(safeReadFile(ledgerPath, { encoding: 'utf8' }) || '');
  const records: PromptVisibilityRecord[] = [];
  for (const [index, line] of raw.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as PromptVisibilityRecord;
      assertRecordShape(parsed);
      records.push(parsed);
    } catch (error) {
      throw new Error(
        `MISSION_LOG_CORRUPT:prompt_visibility_record:${index + 1}${error instanceof Error ? `:${error.message}` : ''}`
      );
    }
  }
  return records;
}
