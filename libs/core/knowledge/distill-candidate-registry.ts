import { randomUUID, createHash } from 'node:crypto';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { nowIso } from '../foundation/time.js';
import { pathResolver } from '../path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReaddir,
  safeWriteFile,
} from '../secure-io.js';
import type { OrganizationWorkLoopSummary } from '../workforce/work-design.js';
import { assertMemoryScope, type MemoryScopeEnvelope } from './memory-scope.js';
import { physicalScopedPath } from '../physical-namespace.js';
import * as path from 'node:path';

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

export function distillCandidateRecordPath(
  candidateId: string,
  scope?: MemoryScopeEnvelope
): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(candidateId))
    throw new Error('[DISTILL_CANDIDATE_INVALID] Invalid candidate id');
  if (!scope) return path.join(DISTILL_DIR, candidateId + '.json');
  const canonical = assertMemoryScope(scope);
  if (!canonical.tenant_slug)
    throw new Error('[DISTILL_SCOPE_REQUIRED] Scoped records require a tenant');
  const key = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  return pathResolver.rootResolve(
    physicalScopedPath(
      'active/shared/runtime',
      canonical,
      'distill-candidates',
      canonical.tier,
      key,
      candidateId + '.json'
    )
  );
}

const distillCandidateRecordCatalog = defineCatalog<DistillCandidateRecord>({
  id: 'distill-candidate-record',
  path: DISTILL_DIR,
  schema: SCHEMA_PATH,
});

function distillCandidateRecordCatalogAtPath(filePath: string) {
  return defineCatalog<DistillCandidateRecord>({
    id: 'distill-candidate-record',
    path: filePath,
    schema: SCHEMA_PATH,
  });
}

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
  const now = nowIso();
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
  const filePath = distillCandidateRecordPath(record.candidate_id, record.scope);
  const updated: DistillCandidateRecord = {
    ...record,
    updated_at: nowIso(),
  };
  let validated: DistillCandidateRecord;
  try {
    validated = distillCandidateRecordCatalogAtPath(filePath).validate(updated, filePath);
  } catch (error) {
    throw new Error(
      `Invalid distill candidate record: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!safeExistsSync(path.dirname(filePath)))
    safeMkdir(path.dirname(filePath), { recursive: true });
  safeWriteFile(filePath, JSON.stringify(validated, null, 2));
  distillCandidateListCache = null;
  return filePath;
}

export function loadDistillCandidateRecord(
  candidateId: string,
  scope?: MemoryScopeEnvelope
): DistillCandidateRecord | null {
  const filePath = distillCandidateRecordPath(candidateId, scope);
  try {
    const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
    if (!safeExistsSync(safeFilePath)) return null;
    if (!safeLstat(safeFilePath).isFile()) {
      throw new Error(`[DISTILL_CANDIDATE] record must be a regular file: ${filePath}`);
    }
    const row = distillCandidateRecordCatalogAtPath(safeFilePath).load();
    if (
      scope &&
      JSON.stringify(row.scope ? assertMemoryScope(row.scope) : null) !==
        JSON.stringify(assertMemoryScope(scope))
    )
      return null;
    return row;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid catalog ')) return null;
    throw error;
  }
}

export function listDistillCandidateRecords(scope?: MemoryScopeEnvelope): DistillCandidateRecord[] {
  if (scope) {
    const dir = path.dirname(distillCandidateRecordPath('scope-list', scope));
    if (!safeExistsSync(dir)) return [];
    return safeReaddir(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => loadDistillCandidateRecord(name.slice(0, -5), scope))
      .filter((row): row is DistillCandidateRecord => Boolean(row))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }
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
  patch: Partial<Omit<DistillCandidateRecord, 'candidate_id' | 'created_at'>>,
  scope?: MemoryScopeEnvelope
): DistillCandidateRecord | null {
  const current = loadDistillCandidateRecord(candidateId, scope);
  if (!current) return null;
  if (
    patch.scope &&
    JSON.stringify(assertMemoryScope(patch.scope)) !==
      JSON.stringify(current.scope ? assertMemoryScope(current.scope) : null)
  )
    throw new Error('[DISTILL_SCOPE_MISMATCH] Scope cannot change during update');
  const next: DistillCandidateRecord = {
    ...current,
    ...patch,
    candidate_id: current.candidate_id,
    created_at: current.created_at,
    updated_at: nowIso(),
  };
  saveDistillCandidateRecord(next);
  return next;
}
