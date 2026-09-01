import { randomUUID } from 'node:crypto';
import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  loadJson,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReaddir,
  safeWriteFile,
} from './secure-io.js';
import type { OrganizationWorkLoopSummary } from './work-design.js';
import type { MemoryScopeEnvelope } from './memory-scope.js';

export interface DistillCandidateRecord {
  candidate_id: string;
  source_type: 'task_session' | 'mission' | 'artifact';
  tier?: 'personal' | 'confidential' | 'public';
  project_id?: string;
  track_id?: string;
  track_name?: string;
  mission_id?: string;
  task_session_id?: string;
  artifact_ids?: string[];
  title: string;
  summary: string;
  status: 'proposed' | 'promoted' | 'archived';
  target_kind: 'pattern' | 'sop_candidate' | 'knowledge_hint' | 'report_template' | 'procedure';
  specialist_id?: string;
  locale?: string;
  work_loop?: OrganizationWorkLoopSummary;
  promoted_ref?: string;
  evidence_refs?: string[];
  created_at: string;
  updated_at: string;
  metadata?: Record<string, unknown>;
  /** Canonical scope; absent only for legacy candidates. */
  scope?: MemoryScopeEnvelope;
}

const SCHEMA_PATH = pathResolver.knowledge('product/schemas/distill-candidate-record.schema.json');
const DISTILL_DIR = pathResolver.shared('runtime/distill-candidates');

function recordPath(candidateId: string): string {
  return `${DISTILL_DIR}/${candidateId}.json`;
}

const distillCandidateRecordCatalog = defineCatalog<DistillCandidateRecord>({
  id: 'distill-candidate-record',
  path: DISTILL_DIR,
  schema: SCHEMA_PATH,
});

let distillCandidateListCache: {
  fingerprint: string;
  records: DistillCandidateRecord[];
} | null = null;

function distillCandidateListFingerprint(entries: string[]): string {
  return entries
    .map((entry) => {
      const stats = safeLstat(`${DISTILL_DIR}/${entry}`);
      return `${entry}:${stats.mode}:${stats.size}:${stats.mtimeMs}`;
    })
    .join('|');
}

export function createDistillCandidateRecord(
  input: Omit<DistillCandidateRecord, 'candidate_id' | 'created_at' | 'updated_at'> & {
    candidate_id?: string;
  }
): DistillCandidateRecord {
  const now = new Date().toISOString();
  return {
    candidate_id:
      input.candidate_id ||
      `DSC-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`,
    created_at: now,
    updated_at: now,
    ...input,
  };
}

export function validateDistillCandidateRecord(value: unknown): value is DistillCandidateRecord {
  try {
    distillCandidateRecordCatalog.validate(value);
    return true;
  } catch {
    return false;
  }
}

export function saveDistillCandidateRecord(record: DistillCandidateRecord): string {
  try {
    distillCandidateRecordCatalog.validate(record);
  } catch (error) {
    throw new Error(
      `Invalid distill candidate record: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!safeExistsSync(DISTILL_DIR)) safeMkdir(DISTILL_DIR, { recursive: true });
  const filePath = recordPath(record.candidate_id);
  const updated: DistillCandidateRecord = {
    ...record,
    updated_at: new Date().toISOString(),
  };
  safeWriteFile(filePath, JSON.stringify(updated, null, 2));
  distillCandidateListCache = null;
  return filePath;
}

export function loadDistillCandidateRecord(candidateId: string): DistillCandidateRecord | null {
  const filePath = recordPath(candidateId);
  try {
    const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
    if (!safeExistsSync(safeFilePath)) return null;
    return distillCandidateRecordCatalog.validate(loadJson<unknown>(safeFilePath), safeFilePath);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid catalog ')) return null;
    throw error;
  }
}

export function listDistillCandidateRecords(): DistillCandidateRecord[] {
  if (!safeExistsSync(DISTILL_DIR)) {
    distillCandidateListCache = null;
    return [];
  }
  const entries = safeReaddir(DISTILL_DIR)
    .filter((entry) => entry.endsWith('.json'))
    .sort();
  const fingerprint = distillCandidateListFingerprint(entries);
  if (distillCandidateListCache?.fingerprint === fingerprint) {
    return distillCandidateListCache.records.map((record) => structuredClone(record));
  }

  const records = entries
    .map((entry) => loadDistillCandidateRecord(entry.replace(/\.json$/, '')))
    .filter((record): record is DistillCandidateRecord => Boolean(record))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  distillCandidateListCache = { fingerprint, records };
  return records.map((record) => structuredClone(record));
}

export function updateDistillCandidateRecord(
  candidateId: string,
  patch: Partial<Omit<DistillCandidateRecord, 'candidate_id' | 'created_at'>>
): DistillCandidateRecord | null {
  const current = loadDistillCandidateRecord(candidateId);
  if (!current) return null;
  const next: DistillCandidateRecord = {
    ...current,
    ...patch,
    candidate_id: current.candidate_id,
    created_at: current.created_at,
    updated_at: new Date().toISOString(),
  };
  saveDistillCandidateRecord(next);
  return next;
}
