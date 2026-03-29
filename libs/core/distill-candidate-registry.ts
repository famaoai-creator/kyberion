import AjvModule, { type ValidateFunction } from 'ajv';
import { randomUUID } from 'node:crypto';
import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeReaddir, safeWriteFile } from './secure-io.js';
import type { OrganizationWorkLoopSummary } from './work-design.js';

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
  target_kind: 'pattern' | 'sop_candidate' | 'knowledge_hint' | 'report_template';
  specialist_id?: string;
  locale?: string;
  work_loop?: OrganizationWorkLoopSummary;
  promoted_ref?: string;
  evidence_refs?: string[];
  created_at: string;
  updated_at: string;
  metadata?: Record<string, unknown>;
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const SCHEMA_PATH = pathResolver.knowledge('public/schemas/distill-candidate-record.schema.json');
const DISTILL_DIR = pathResolver.shared('runtime/distill-candidates');
let validateFn: ValidateFunction | null = null;

function ensureValidator(): ValidateFunction {
  if (validateFn) return validateFn;
  validateFn = compileSchemaFromPath(ajv, SCHEMA_PATH);
  return validateFn;
}

function recordPath(candidateId: string): string {
  return `${DISTILL_DIR}/${candidateId}.json`;
}

export function createDistillCandidateRecord(
  input: Omit<DistillCandidateRecord, 'candidate_id' | 'created_at' | 'updated_at'> & { candidate_id?: string },
): DistillCandidateRecord {
  const now = new Date().toISOString();
  return {
    candidate_id: input.candidate_id || `DSC-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`,
    created_at: now,
    updated_at: now,
    ...input,
  };
}

export function validateDistillCandidateRecord(value: unknown): value is DistillCandidateRecord {
  return Boolean(ensureValidator()(value));
}

export function saveDistillCandidateRecord(record: DistillCandidateRecord): string {
  if (!validateDistillCandidateRecord(record)) {
    const errors = (ensureValidator().errors || []).map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`);
    throw new Error(`Invalid distill candidate record: ${errors.join('; ')}`);
  }
  if (!safeExistsSync(DISTILL_DIR)) safeMkdir(DISTILL_DIR, { recursive: true });
  const filePath = recordPath(record.candidate_id);
  const updated: DistillCandidateRecord = {
    ...record,
    updated_at: new Date().toISOString(),
  };
  safeWriteFile(filePath, JSON.stringify(updated, null, 2));
  return filePath;
}

export function loadDistillCandidateRecord(candidateId: string): DistillCandidateRecord | null {
  const filePath = recordPath(candidateId);
  if (!safeExistsSync(filePath)) return null;
  const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
  const parsed = JSON.parse(raw) as DistillCandidateRecord;
  return validateDistillCandidateRecord(parsed) ? parsed : null;
}

export function listDistillCandidateRecords(): DistillCandidateRecord[] {
  if (!safeExistsSync(DISTILL_DIR)) return [];
  return safeReaddir(DISTILL_DIR)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => loadDistillCandidateRecord(entry.replace(/\.json$/, '')))
    .filter((record): record is DistillCandidateRecord => Boolean(record))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export function updateDistillCandidateRecord(
  candidateId: string,
  patch: Partial<Omit<DistillCandidateRecord, 'candidate_id' | 'created_at'>>,
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
