import AjvModule, { type ValidateFunction } from 'ajv';
import { randomUUID } from 'node:crypto';
import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { safeAppendFileSync, safeExistsSync, safeMkdir, safeReadFile, safeWriteFile } from './secure-io.js';

export type MemoryCandidateSourceType = 'mission' | 'task_session' | 'artifact' | 'incident';
export type MemoryCandidateKind = 'sop' | 'template' | 'heuristic' | 'risk_rule' | 'clarification_prompt';
export type MemoryCandidateTier = 'public' | 'confidential' | 'personal';
export type MemoryCandidateStatus = 'queued' | 'approved' | 'rejected' | 'promoted';

export interface MemoryCandidate {
  candidate_id: string;
  source_type: MemoryCandidateSourceType;
  source_ref: string;
  proposed_memory_kind: MemoryCandidateKind;
  summary: string;
  evidence_refs: string[];
  sensitivity_tier: MemoryCandidateTier;
  ratification_required: boolean;
  status: MemoryCandidateStatus;
  queued_at: string;
  ratified_at?: string;
  ratification_note?: string;
  promoted_ref?: string;
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const SCHEMA_PATH = pathResolver.rootResolve('schemas/memory-candidate.schema.json');
const QUEUE_PATH = pathResolver.shared('runtime/memory/promotion-queue.jsonl');

let validateFn: ValidateFunction | null = null;

function ensureValidator(): ValidateFunction {
  if (validateFn) return validateFn;
  validateFn = compileSchemaFromPath(ajv, SCHEMA_PATH);
  return validateFn;
}

function normalizeEvidenceRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter(Boolean);
}

function parseJsonl(raw: string): MemoryCandidate[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as MemoryCandidate);
}

function assertPublicTierReferencesSafe(candidate: MemoryCandidate): void {
  if (candidate.sensitivity_tier !== 'public') return;
  const hasRestrictedRef = candidate.evidence_refs.some((ref) =>
    /(^|\/)(knowledge\/)?(confidential|personal)(\/|$)/iu.test(ref),
  );
  if (hasRestrictedRef) {
    throw new Error(
      'Public-tier memory promotion cannot include confidential/personal evidence references.',
    );
  }
}

function ensureQueueDir(): void {
  const dir = pathResolver.shared('runtime/memory');
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
}

function inferMissionMemoryKind(missionType?: string): MemoryCandidateKind {
  const normalized = String(missionType || '').toLowerCase();
  if (normalized.includes('incident') || normalized.includes('risk')) return 'risk_rule';
  if (normalized.includes('report') || normalized.includes('template')) return 'template';
  if (normalized.includes('research') || normalized.includes('analysis')) return 'clarification_prompt';
  return 'sop';
}

export function createMemoryPromotionCandidate(input: {
  candidateId?: string;
  sourceType: MemoryCandidateSourceType;
  sourceRef: string;
  proposedMemoryKind: MemoryCandidateKind;
  summary: string;
  evidenceRefs: string[];
  sensitivityTier: MemoryCandidateTier;
  ratificationRequired?: boolean;
  status?: MemoryCandidateStatus;
  queuedAt?: string;
}): MemoryCandidate {
  return {
    candidate_id: input.candidateId || `MEM-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`,
    source_type: input.sourceType,
    source_ref: String(input.sourceRef || '').trim(),
    proposed_memory_kind: input.proposedMemoryKind,
    summary: String(input.summary || '').trim(),
    evidence_refs: normalizeEvidenceRefs(input.evidenceRefs),
    sensitivity_tier: input.sensitivityTier,
    ratification_required: typeof input.ratificationRequired === 'boolean'
      ? input.ratificationRequired
      : input.sensitivityTier !== 'personal',
    status: input.status || 'queued',
    queued_at: input.queuedAt || new Date().toISOString(),
  };
}

export function validateMemoryPromotionCandidate(value: unknown): { valid: boolean; errors: string[] } {
  const validate = ensureValidator();
  const valid = validate(value);
  const errors = (validate.errors || []).map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`);
  return { valid: Boolean(valid), errors };
}

export function enqueueMemoryPromotionCandidate(candidate: MemoryCandidate): string {
  if ((candidate.evidence_refs || []).length === 0) {
    throw new Error('Memory promotion candidate requires at least one evidence_ref.');
  }
  assertPublicTierReferencesSafe(candidate);
  const validation = validateMemoryPromotionCandidate(candidate);
  if (!validation.valid) {
    throw new Error(`Invalid memory promotion candidate: ${validation.errors.join('; ')}`);
  }
  ensureQueueDir();
  safeAppendFileSync(QUEUE_PATH, `${JSON.stringify(candidate)}\n`);
  return QUEUE_PATH;
}

export function listMemoryPromotionCandidates(): MemoryCandidate[] {
  if (!safeExistsSync(QUEUE_PATH)) return [];
  const raw = safeReadFile(QUEUE_PATH, { encoding: 'utf8' }) as string;
  return parseJsonl(raw);
}

export function loadMemoryPromotionCandidate(candidateId: string): MemoryCandidate | null {
  const normalized = String(candidateId || '').trim();
  if (!normalized) return null;
  return listMemoryPromotionCandidates().find((row) => row.candidate_id === normalized) || null;
}

export function updateMemoryPromotionCandidateStatus(input: {
  candidateId: string;
  status: MemoryCandidateStatus;
  ratificationNote?: string;
  promotedRef?: string;
}): MemoryCandidate | null {
  if (!safeExistsSync(QUEUE_PATH)) return null;
  const rows = listMemoryPromotionCandidates();
  const index = rows.findIndex((row) => row.candidate_id === input.candidateId);
  if (index < 0) return null;
  const current = rows[index] as MemoryCandidate;
  const next: MemoryCandidate = {
    ...current,
    status: input.status,
    ...(input.status === 'approved' || input.status === 'promoted' ? { ratified_at: new Date().toISOString() } : {}),
    ...(input.ratificationNote ? { ratification_note: input.ratificationNote.trim() } : {}),
    ...(input.promotedRef ? { promoted_ref: input.promotedRef.trim() } : {}),
  };
  const validation = validateMemoryPromotionCandidate(next);
  if (!validation.valid) {
    throw new Error(`Invalid memory promotion candidate update: ${validation.errors.join('; ')}`);
  }
  rows[index] = next;
  ensureQueueDir();
  safeWriteFile(QUEUE_PATH, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  return next;
}

export function queueMissionMemoryPromotionCandidate(input: {
  missionId: string;
  missionType?: string;
  tier: MemoryCandidateTier;
  summary: string;
  evidenceRefs: string[];
}): MemoryCandidate {
  const candidate = createMemoryPromotionCandidate({
    sourceType: 'mission',
    sourceRef: `mission:${input.missionId}`,
    proposedMemoryKind: inferMissionMemoryKind(input.missionType),
    summary: input.summary,
    evidenceRefs: input.evidenceRefs,
    sensitivityTier: input.tier,
  });
  enqueueMemoryPromotionCandidate(candidate);
  return candidate;
}

export function memoryPromotionQueuePath(): string {
  return QUEUE_PATH;
}
