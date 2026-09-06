import { appendJsonLine, readJsonLines } from './foundation/json.js';
import { nowIso } from './foundation/time.js';
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { defineCatalog, type GovernedCatalog } from './foundation/governed-catalog.js';
import { assertModuleInvariant } from './invariants.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat, safeMkdir } from './secure-io.js';

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

const PROMPT_VISIBILITY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/prompt-visibility-record.schema.json'
);

function required(label: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`[PROMPT_VISIBILITY_INVALID] ${label} is required`);
  return normalized;
}

function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function ledgerFile(input: AppendPromptVisibilityRecordInput): string {
  const candidate =
    input.ledgerPath || path.join(input.missionPath, 'coordination', 'prompt-visibility.jsonl');
  return assertSafeRepositoryPath(candidate, { allowMissingLeaf: true });
}

function assertRecordShape(record: PromptVisibilityRecord): void {
  assertModuleInvariant('prompt-visibility-ledger', 'record-shape', record);
}

function promptVisibilityCatalog(filePath: string): GovernedCatalog<PromptVisibilityRecord> {
  return defineCatalog<PromptVisibilityRecord>({
    id: 'prompt-visibility-record',
    path: filePath,
    schema: PROMPT_VISIBILITY_SCHEMA_PATH,
  });
}

function ensureRegularLedgerFile(filePath: string): void {
  if (safeExistsSync(filePath) && !safeLstat(filePath).isFile()) {
    throw new Error(`[PROMPT_VISIBILITY_INVALID] ledger must be a regular file: ${filePath}`);
  }
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
    ts: input.now || nowIso(),
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
  ensureRegularLedgerFile(file);
  appendJsonLine(file, promptVisibilityCatalog(file).validate(record, file));
  return record;
}

export function loadPromptVisibilityLedger(ledgerPath: string): PromptVisibilityRecord[] {
  const safeLedgerPath = assertSafeRepositoryPath(ledgerPath, { allowMissingLeaf: true });
  ensureRegularLedgerFile(safeLedgerPath);
  const catalog = promptVisibilityCatalog(safeLedgerPath);
  return readJsonLines<PromptVisibilityRecord>(safeLedgerPath, {
    onMalformed: (error, lineNumber) => {
      throw new Error(
        `MISSION_LOG_CORRUPT:prompt_visibility_record:${lineNumber}${error instanceof Error ? `:${error.message}` : ''}`
      );
    },
    map: (value, lineNumber) => {
      const parsed = catalog.validate(value, `${safeLedgerPath}:${lineNumber}`);
      assertRecordShape(parsed);
      return parsed;
    },
  });
}
