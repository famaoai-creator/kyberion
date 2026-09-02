import { appendJsonLine, readJsonLines } from './foundation/json.js';
import type { ValidateFunction } from 'ajv';
import { getRegisteredEnvText } from './foundation/env.js';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { compileSchema } from './foundation/ajv.js';
import { nowIso } from './foundation/time.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeStat,
  safeWriteFile,
} from './secure-io.js';
import { assessMissionMemoryCandidate } from './mission-assessment.js';
import { normalizeMemoryFact } from './memory-notebook.js';
import { assertMemoryScope, type MemoryScopeEnvelope } from './memory-scope.js';
import { scopeContextKey } from './scope-context.js';
import { auditChain } from './audit-chain.js';
import { physicalScopedPath } from './physical-namespace.js';

export type MemoryCandidateSourceType = 'mission' | 'task_session' | 'artifact' | 'incident';
export type MemoryCandidateKind =
  'sop' | 'template' | 'heuristic' | 'risk_rule' | 'clarification_prompt' | 'archive_advisory';
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
  content_hash?: string;
  occurrences?: number;
  last_seen?: string;
  ratified_at?: string;
  ratification_note?: string;
  promoted_ref?: string;
  /** Hash-chain audit entry created when this candidate was first enqueued. */
  audit_ref?: string;
  /** Scope envelope retained with the candidate; absent only for legacy records. */
  scope?: MemoryScopeEnvelope;
  /** Required when a tenant-scoped candidate is promoted to a broader tier. */
  promotion?: {
    source_tenant_slug: string;
    target_tier: MemoryCandidateTier;
    redacted: boolean;
    approved_by?: string;
    approved_at?: string;
  };
}

const SCHEMA_PATH = pathResolver.rootResolve(
  'knowledge/product/schemas/memory-candidate.schema.json'
);
const GLOBAL_QUEUE_PATH = 'active/shared/runtime/memory/promotion-queue.jsonl';
const TENANT_RUNTIME_ROOT = 'active/shared/runtime/tenants';

function tenantQueueScope(scope: MemoryScopeEnvelope): {
  tier: MemoryScopeEnvelope['tier'];
  tenant_slug: string;
  scope_kind: 'tenant';
} {
  if (!scope.tenant_slug) throw new Error('Tenant-scoped memory queue requires tenant_slug.');
  // A promotion queue is owned by the tenant, even when the candidate was
  // observed inside a project/mission. Do not let a deeper work scope create
  // a separate queue or weaken the tenant boundary.
  return { tier: scope.tier, tenant_slug: scope.tenant_slug, scope_kind: 'tenant' };
}

// Tests namespace the queue via KYBERION_MEMORY_QUEUE_PATH so parallel suites
// never clobber their real queue file (resolved lazily per call). In
// production, tenant-scoped candidates are physically isolated under the
// tenant runtime namespace; legacy/unscoped candidates remain in the global
// queue until the migration steward adopts them.
function resolveQueuePath(scope?: MemoryScopeEnvelope): string {
  const override = getRegisteredEnvText('KYBERION_MEMORY_QUEUE_PATH')?.trim();
  const candidate = override
    ? pathResolver.rootResolve(override)
    : scope?.tenant_slug
      ? pathResolver.rootResolve(
          physicalScopedPath(
            'active/shared/runtime',
            tenantQueueScope(scope),
            'memory',
            'promotion-queue.jsonl'
          )
        )
      : pathResolver.rootResolve(GLOBAL_QUEUE_PATH);
  return assertSafeRepositoryPath(candidate, { allowMissingLeaf: true });
}

function queuePathsForAllScopes(): string[] {
  if (getRegisteredEnvText('KYBERION_MEMORY_QUEUE_PATH')?.trim()) return [resolveQueuePath()];
  const paths = [resolveQueuePath()];
  let tenantRoot: string;
  try {
    tenantRoot = assertSafeRepositoryPath(pathResolver.rootResolve(TENANT_RUNTIME_ROOT), {
      allowMissingLeaf: true,
    });
  } catch {
    return paths;
  }
  if (!safeExistsSync(tenantRoot) || !safeStat(tenantRoot).isDirectory()) return paths;
  for (const tenantSlug of safeReaddir(tenantRoot)) {
    try {
      const tenantDir = assertSafeRepositoryPath(path.join(tenantRoot, tenantSlug), {
        allowMissingLeaf: true,
      });
      if (!safeStat(tenantDir).isDirectory()) continue;
      const candidatePath = assertSafeRepositoryPath(
        path.join(tenantDir, 'memory', 'promotion-queue.jsonl'),
        { allowMissingLeaf: true }
      );
      if (safeExistsSync(candidatePath)) paths.push(candidatePath);
    } catch {
      // An unsafe tenant shard must not poison the global queue scan.
    }
  }
  return paths;
}

let validateFn: ValidateFunction | null = null;

function ensureValidator(): ValidateFunction {
  if (validateFn) return validateFn;
  validateFn = compileSchema(SCHEMA_PATH);
  return validateFn;
}

function normalizeEvidenceRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter(Boolean);
}

function normalizeContent(value: string): string {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function computeContentHash(candidate: Pick<MemoryCandidate, 'summary'>): string {
  return createHash('sha256').update(normalizeContent(candidate.summary)).digest('hex');
}

function resolveContentHash(candidate: Pick<MemoryCandidate, 'summary' | 'content_hash'>): string {
  return String(candidate.content_hash || '').trim() || computeContentHash(candidate);
}

function resolveScopeKey(scope?: MemoryScopeEnvelope): string {
  if (!scope) return 'legacy';
  const normalized = assertMemoryScope(scope, scope.tier);
  return JSON.stringify({
    context: scopeContextKey(normalized),
    owner_nhi: normalized.owner_nhi || null,
    allowed_audience: normalized.allowed_audience || [],
    promotion_policy: normalized.promotion_policy || null,
  });
}

/** Stable identity used when comparing or updating physical queue records. */
export function memoryPromotionScopeKey(scope?: MemoryScopeEnvelope): string {
  return resolveScopeKey(scope);
}

function normalizeOccurrenceCount(value: unknown): number {
  const count = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 0;
  return Math.max(1, count);
}

function assertPublicTierReferencesSafe(candidate: MemoryCandidate): void {
  // `sensitivity_tier` is the candidate's destination tier.  The envelope is
  // the source scope and must be validated against its own tier so a
  // confidential tenant cannot be made to look public merely by requesting a
  // public promotion.
  if (candidate.scope) assertMemoryScope(candidate.scope, candidate.scope.tier);
  if (candidate.sensitivity_tier !== 'public') return;
  if (candidate.scope?.tenant_slug) {
    const promotion = candidate.promotion;
    if (
      !promotion ||
      promotion.target_tier !== 'public' ||
      promotion.source_tenant_slug !== candidate.scope.tenant_slug ||
      promotion.redacted !== true ||
      !promotion.approved_by
    ) {
      throw new Error(
        'Tenant-scoped public memory requires a brokered, redacted promotion with an approver.'
      );
    }
  }
  const hasRestrictedRef = candidate.evidence_refs.some((ref) =>
    /(^|\/)(knowledge\/)?(confidential|personal)(\/|$)/iu.test(ref)
  );
  if (hasRestrictedRef) {
    throw new Error(
      'Public-tier memory promotion cannot include confidential/personal evidence references.'
    );
  }
}

function ensureQueueDir(queuePath: string): void {
  const dir = assertSafeRepositoryPath(path.dirname(queuePath), { allowMissingLeaf: true });
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
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
  scope?: MemoryScopeEnvelope;
  promotion?: MemoryCandidate['promotion'];
}): MemoryCandidate {
  const now = input.queuedAt || nowIso();
  const summary = normalizeMemoryFact(String(input.summary || ''), Date.parse(now) || Date.now());
  return {
    candidate_id:
      input.candidateId ||
      `MEM-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`,
    source_type: input.sourceType,
    source_ref: String(input.sourceRef || '').trim(),
    proposed_memory_kind: input.proposedMemoryKind,
    summary,
    evidence_refs: normalizeEvidenceRefs(input.evidenceRefs),
    sensitivity_tier: input.sensitivityTier,
    ratification_required:
      typeof input.ratificationRequired === 'boolean'
        ? input.ratificationRequired
        : input.sensitivityTier !== 'personal',
    status: input.status || 'queued',
    queued_at: now,
    content_hash: computeContentHash({ summary }),
    occurrences: 1,
    last_seen: now,
    ...(input.scope ? { scope: assertMemoryScope(input.scope, input.scope.tier) } : {}),
    ...(input.promotion ? { promotion: input.promotion } : {}),
  };
}

export function validateMemoryPromotionCandidate(value: unknown): {
  valid: boolean;
  errors: string[];
} {
  const validate = ensureValidator();
  const valid = validate(value);
  const errors = (validate.errors || []).map(
    (error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`
  );
  return { valid: Boolean(valid), errors };
}

export function enqueueMemoryPromotionCandidate(candidate: MemoryCandidate): string {
  if ((candidate.evidence_refs || []).length === 0) {
    throw new Error('Memory promotion candidate requires at least one evidence_ref.');
  }
  const normalizedCandidate: MemoryCandidate = {
    ...candidate,
    summary: normalizeMemoryFact(candidate.summary, Date.parse(candidate.queued_at) || Date.now()),
  };
  assertPublicTierReferencesSafe(normalizedCandidate);
  const validation = validateMemoryPromotionCandidate(normalizedCandidate);
  if (!validation.valid) {
    throw new Error(`Invalid memory promotion candidate: ${validation.errors.join('; ')}`);
  }
  const queuePath = resolveQueuePath(normalizedCandidate.scope);
  ensureQueueDir(queuePath);
  const rows = listMemoryPromotionCandidates(normalizedCandidate.scope);
  const contentHash = resolveContentHash(normalizedCandidate);
  const normalizedSourceRef = String(normalizedCandidate.source_ref || '').trim();
  const normalizedScopeKey = resolveScopeKey(normalizedCandidate.scope);
  const now =
    normalizedCandidate.last_seen || normalizedCandidate.queued_at || nowIso();
  const existingIndex = rows.findIndex(
    (row) =>
      String(row.source_ref || '').trim() === normalizedSourceRef &&
      resolveContentHash(row) === contentHash &&
      resolveScopeKey(row.scope) === normalizedScopeKey
  );
  if (existingIndex >= 0) {
    const current = rows[existingIndex] as MemoryCandidate;
    const nextOccurrences = normalizeOccurrenceCount(current.occurrences) + 1;
    const mergedEvidenceRefs = Array.from(
      new Set(
        [...current.evidence_refs, ...normalizedCandidate.evidence_refs]
          .map((item) => String(item || '').trim())
          .filter(Boolean)
      )
    );
    const next: MemoryCandidate = {
      ...current,
      evidence_refs: mergedEvidenceRefs,
      source_type: current.source_type,
      source_ref: current.source_ref,
      proposed_memory_kind: current.proposed_memory_kind,
      summary: current.summary,
      sensitivity_tier: current.sensitivity_tier,
      ratification_required: current.ratification_required,
      status: current.status,
      queued_at: current.queued_at || normalizedCandidate.queued_at,
      content_hash: contentHash,
      occurrences: nextOccurrences,
      last_seen: now,
      ...(current.scope ? { scope: current.scope } : {}),
      ...(current.promotion ? { promotion: current.promotion } : {}),
    };
    const updatedValidation = validateMemoryPromotionCandidate(next);
    if (!updatedValidation.valid) {
      throw new Error(
        `Invalid memory promotion candidate update: ${updatedValidation.errors.join('; ')}`
      );
    }
    rows[existingIndex] = next;
    safeWriteFile(queuePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    return queuePath;
  }
  const nextCandidate: MemoryCandidate = {
    ...normalizedCandidate,
    content_hash: contentHash,
    occurrences: normalizeOccurrenceCount(candidate.occurrences),
    last_seen: now,
  };
  if (!nextCandidate.audit_ref && process.env.NODE_ENV !== 'test') {
    try {
      const audit = auditChain.record({
        agentId: getRegisteredEnvText('KYBERION_AGENT_ID') || 'knowledge-promotion-queue',
        action: 'knowledge_promotion_candidate',
        operation: 'enqueue',
        result: 'completed',
        tenantSlug: nextCandidate.scope?.tenant_slug,
        correlationId: nextCandidate.candidate_id,
        metadata: {
          candidate_id: nextCandidate.candidate_id,
          source_ref: nextCandidate.source_ref,
          sensitivity_tier: nextCandidate.sensitivity_tier,
        },
      });
      nextCandidate.audit_ref = `audit:${audit.id}`;
    } catch {
      // Queue durability remains available during first-run/offline setup;
      // the validation sweep reports the missing continuity link.
    }
  }
  const nextValidation = validateMemoryPromotionCandidate(nextCandidate);
  if (!nextValidation.valid) {
    throw new Error(`Invalid memory promotion candidate: ${nextValidation.errors.join('; ')}`);
  }
  appendJsonLine(queuePath, nextCandidate);
  return queuePath;
}

export function listMemoryPromotionCandidates(scope?: MemoryScopeEnvelope): MemoryCandidate[] {
  return (scope ? [resolveQueuePath(scope)] : queuePathsForAllScopes())
    .filter((queuePath, index, all) => all.indexOf(queuePath) === index)
    .filter((queuePath) => safeExistsSync(queuePath))
    .flatMap((queuePath) => readJsonLines<MemoryCandidate>(queuePath));
}

export function loadMemoryPromotionCandidate(
  candidateId: string,
  scope?: MemoryScopeEnvelope
): MemoryCandidate | null {
  const normalized = String(candidateId || '').trim();
  if (!normalized) return null;
  return (
    listMemoryPromotionCandidates(scope).find((row) => row.candidate_id === normalized) || null
  );
}

export function updateMemoryPromotionCandidateStatus(input: {
  candidateId: string;
  status: MemoryCandidateStatus;
  ratificationNote?: string;
  promotedRef?: string;
  scope?: MemoryScopeEnvelope;
  /** Update every physical duplicate in the selected scope. */
  allMatching?: boolean;
}): MemoryCandidate | null {
  const requestedScopeKey = input.scope ? resolveScopeKey(input.scope) : undefined;
  const candidateQueuePath = input.scope ? resolveQueuePath(input.scope) : undefined;
  const candidatePaths = input.allMatching
    ? queuePathsForAllScopes()
    : candidateQueuePath
      ? [candidateQueuePath]
      : queuePathsForAllScopes();
  const matchingQueuePaths = candidatePaths.filter((candidatePath) => {
    if (!safeExistsSync(candidatePath)) return false;
    const rows = readJsonLines<MemoryCandidate>(candidatePath);
    return rows.some(
      (row) =>
        row.candidate_id === input.candidateId &&
        (!requestedScopeKey || resolveScopeKey(row.scope) === requestedScopeKey)
    );
  });
  if (!input.allMatching && !candidateQueuePath && matchingQueuePaths.length > 1) {
    throw new Error(
      `[MEMORY_PROMOTION_AMBIGUOUS] candidate '${input.candidateId}' exists in multiple scope queues; provide scope`
    );
  }
  if (input.allMatching && !requestedScopeKey) {
    const matched = matchingQueuePaths.flatMap((queuePath) =>
      readJsonLines<MemoryCandidate>(queuePath).filter(
        (row) => row.candidate_id === input.candidateId
      )
    );
    const scopeKeys = new Set(matched.map((row) => resolveScopeKey(row.scope)));
    if (scopeKeys.size > 1) {
      throw new Error(
        `[MEMORY_PROMOTION_AMBIGUOUS] candidate '${input.candidateId}' exists in multiple scopes; provide scope`
      );
    }
  }
  if (matchingQueuePaths.length === 0) return null;

  let firstUpdated: MemoryCandidate | null = null;
  const ratifiedAt = nowIso();
  for (const queuePath of matchingQueuePaths) {
    const rows = readJsonLines<MemoryCandidate>(queuePath);
    let changed = false;
    for (let index = 0; index < rows.length; index += 1) {
      const current = rows[index] as MemoryCandidate;
      if (
        current.candidate_id !== input.candidateId ||
        (requestedScopeKey && resolveScopeKey(current.scope) !== requestedScopeKey)
      ) {
        continue;
      }
      const next: MemoryCandidate = {
        ...current,
        status: input.status,
        ...(input.status === 'approved' || input.status === 'promoted'
          ? { ratified_at: ratifiedAt }
          : {}),
        ...(input.ratificationNote ? { ratification_note: input.ratificationNote.trim() } : {}),
        ...(input.promotedRef ? { promoted_ref: input.promotedRef.trim() } : {}),
      };
      const validation = validateMemoryPromotionCandidate(next);
      if (!validation.valid) {
        throw new Error(
          `Invalid memory promotion candidate update: ${validation.errors.join('; ')}`
        );
      }
      rows[index] = next;
      firstUpdated ||= next;
      changed = true;
      if (!input.allMatching) break;
    }
    if (changed) {
      ensureQueueDir(queuePath);
      safeWriteFile(queuePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    }
  }
  return firstUpdated;
}

export function queueMissionMemoryPromotionCandidate(input: {
  missionId: string;
  missionType?: string;
  tier: MemoryCandidateTier;
  summary: string;
  evidenceRefs: string[];
  scope?: MemoryScopeEnvelope;
}): MemoryCandidate {
  const assessment = assessMissionMemoryCandidate({
    missionId: input.missionId,
    missionType: input.missionType,
    summary: input.summary,
    evidenceCount: Array.isArray(input.evidenceRefs) ? input.evidenceRefs.length : 0,
    tier: input.tier,
  });
  if (!assessment.eligible) {
    throw new Error(`Mission memory candidate not eligible: ${assessment.reason}`);
  }
  const candidate = createMemoryPromotionCandidate({
    sourceType: 'mission',
    sourceRef: `mission:${input.missionId}`,
    proposedMemoryKind: assessment.proposedKind,
    summary: input.summary,
    evidenceRefs: input.evidenceRefs,
    sensitivityTier: input.tier,
    ...(input.scope ? { scope: input.scope } : {}),
  });
  enqueueMemoryPromotionCandidate(candidate);
  return candidate;
}

export function memoryPromotionQueuePath(scope?: MemoryScopeEnvelope): string {
  return resolveQueuePath(scope);
}
