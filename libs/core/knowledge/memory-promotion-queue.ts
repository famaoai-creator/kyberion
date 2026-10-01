import { appendJsonLine, readJsonLines } from '../foundation/json.js';
import type { ValidateFunction } from 'ajv';
import { getRegisteredEnvText } from '../foundation/env.js';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { compileSchema } from '../foundation/ajv.js';
import { nowIso } from '../foundation/time.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReaddir,
  safeStat,
  safeWriteFile,
} from '../secure-io.js';
import { assessMissionMemoryCandidate } from '../mission/mission-assessment.js';
import { normalizeMemoryFact } from './memory-notebook.js';
import { assertMemoryScope, type MemoryScopeEnvelope } from './memory-scope.js';
import { scopeContextKey } from '../scope-context.js';
import { auditChain } from '../governance/audit-chain.js';
import { physicalScopedPath } from '../physical-namespace.js';
import type { HumanDecidedBy } from '../mission/mission-types.js';

export type MemoryCandidateSourceType = 'mission' | 'task_session' | 'artifact' | 'incident';
export type MemoryCandidateKind =
  'sop' | 'template' | 'heuristic' | 'risk_rule' | 'clarification_prompt' | 'archive_advisory';
/** D7: sensitivity tier is single-sourced from the scope envelope (MemoryScopeEnvelope['tier']). */
export type MemoryCandidateTier = MemoryScopeEnvelope['tier'];
export type MemoryCandidateStatus = 'queued' | 'approved' | 'rejected' | 'promoted';
/**
 * D7: knowledge ownership is distinct from sensitivity_tier and has no scope-envelope
 * axis, so this queue-side declaration remains the canonical vocabulary (consumers
 * reference MemoryCandidate['knowledge_domain'] rather than re-declaring it).
 */
export type MemoryKnowledgeDomain = 'product' | 'organization' | 'personal' | 'unclassified';
/**
 * D7: tagged evidence reference. Persisted queue rows keep the legacy canonical
 * string form (`artifact:<id>` | knowledge path); use parse/formatMemoryEvidenceRef
 * to convert. memory-candidate.schema.json accepts both forms.
 */
export type MemoryEvidenceRef =
  { kind: 'artifact_id'; artifact_id: string } | { kind: 'knowledge_path'; knowledge_path: string };
/** Input form accepted wherever evidence refs are supplied (legacy strings preserved verbatim). */
export type MemoryEvidenceRefInput = string | MemoryEvidenceRef;
/**
 * D7: brokered promotion grant. The scope envelope stays authoritative for the
 * source tenant (see getMemoryPromotionSourceTenant); the grant records the
 * redaction decision and approver for the audit trail.
 */
export interface MemoryPromotionGrant {
  source_tenant_slug: string;
  target_tier: MemoryCandidateTier;
  redacted: boolean;
  approved_by?: string;
  approved_at?: string;
}
/**
 * KL-04: who ratifies an approved candidate. `steward` (default) ratifies at
 * approval time; `pr_review` defers ratification to the merge of the PR that
 * carries the promoted record, confirmed at mission finish against origin/main.
 */
export type MemoryApprovalChannel = 'steward' | 'pr_review';
export const MEMORY_APPROVAL_CHANNELS: readonly MemoryApprovalChannel[] = ['steward', 'pr_review'];

export interface MemoryCandidate {
  candidate_id: string;
  source_type: MemoryCandidateSourceType;
  source_ref: string;
  /** Knowledge ownership, distinct from sensitivity_tier. Legacy records omit this and retain organization routing. */
  knowledge_domain?: MemoryKnowledgeDomain;
  proposed_memory_kind: MemoryCandidateKind;
  summary: string;
  /** Human-curated durable knowledge payload; mission candidates cannot be approved without it. */
  curation?: { title: string; summary: string; content: string; evidence_refs: string[] };
  evidence_refs: string[];
  sensitivity_tier: MemoryCandidateTier;
  ratification_required: boolean;
  status: MemoryCandidateStatus;
  queued_at: string;
  content_hash?: string;
  occurrences?: number;
  last_seen?: string;
  ratified_at?: string;
  /** KL-04: origin/main commit that contained the promoted record (pr_review channel). */
  ratified_commit?: string;
  /** KL-04: ref the ratification was checked against, e.g. `origin/main`. */
  ratification_target?: string;
  /** KL-04: ratification channel chosen at approval; absent means `steward`. */
  approval_channel?: MemoryApprovalChannel;
  ratification_note?: string;
  /** FD-10 wave 1b: the human member who approved/rejected this candidate. */
  decided_by?: HumanDecidedBy;
  promoted_ref?: string;
  /** Hash-chain audit entry created when this candidate was first enqueued. */
  audit_ref?: string;
  /** Scope envelope retained with the candidate; absent only for legacy records. */
  scope?: MemoryScopeEnvelope;
  /** Required when a tenant-scoped candidate is promoted to a broader tier. */
  promotion?: MemoryPromotionGrant;
}

const SCHEMA_PATH = pathResolver.rootResolve(
  'knowledge/product/schemas/memory-candidate.schema.json'
);
const GLOBAL_QUEUE_PATH = 'active/shared/runtime/memory/promotion-queue.jsonl';
const TENANT_RUNTIME_ROOT = 'active/shared/runtime/tenants';

export function isPublicMemoryEvidencePath(ref: string): boolean {
  const normalized = String(ref || '')
    .trim()
    .replace(/\\/g, '/');
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    return false;
  }
  const canonical = path.posix.normalize(normalized);
  return (
    canonical.startsWith('knowledge/public/') || canonical.startsWith('active/missions/public/')
  );
}

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
  return value
    .map((item) =>
      typeof item === 'string'
        ? item.trim()
        : item && typeof item === 'object'
          ? formatMemoryEvidenceRef(item as MemoryEvidenceRef)
          : String(item || '').trim()
    )
    .filter(Boolean);
}

/**
 * D7: parse any evidence-ref input into its tagged form. Legacy strings:
 * `artifact:<id>` → artifact_id, anything else → knowledge_path.
 */
export function parseMemoryEvidenceRef(ref: MemoryEvidenceRefInput): MemoryEvidenceRef {
  if (typeof ref === 'object' && ref !== null) {
    if (ref.kind === 'artifact_id' && String(ref.artifact_id || '').trim()) {
      return { kind: 'artifact_id', artifact_id: String(ref.artifact_id).trim() };
    }
    if (ref.kind === 'knowledge_path' && String(ref.knowledge_path || '').trim()) {
      return { kind: 'knowledge_path', knowledge_path: String(ref.knowledge_path).trim() };
    }
    throw new Error(
      '[MEMORY_EVIDENCE_REF_INVALID] tagged evidence ref needs artifact_id or knowledge_path.'
    );
  }
  const text = String(ref || '').trim();
  if (!text) {
    throw new Error('[MEMORY_EVIDENCE_REF_INVALID] evidence ref must not be empty.');
  }
  if (text.startsWith('artifact:')) {
    const artifactId = text.slice('artifact:'.length).trim();
    if (!artifactId) {
      throw new Error('[MEMORY_EVIDENCE_REF_INVALID] artifact evidence ref needs an id.');
    }
    return { kind: 'artifact_id', artifact_id: artifactId };
  }
  return { kind: 'knowledge_path', knowledge_path: text };
}

/** D7: canonical persisted string form of an evidence ref (legacy strings pass through trimmed). */
export function formatMemoryEvidenceRef(ref: MemoryEvidenceRefInput): string {
  if (typeof ref === 'string') return String(ref || '').trim();
  const parsed = parseMemoryEvidenceRef(ref);
  return parsed.kind === 'artifact_id' ? `artifact:${parsed.artifact_id}` : parsed.knowledge_path;
}

/**
 * D7: envelope-first source tenant. The scope envelope is the single source of
 * truth; legacy candidates without an envelope may use the promotion grant.
 * Read-only helper — validation paths still require the explicit grant fields.
 */
export function getMemoryPromotionSourceTenant(
  candidate: Pick<MemoryCandidate, 'scope' | 'promotion'>
): string | null {
  const scoped = String(candidate.scope?.tenant_slug || '').trim();
  if (scoped) return scoped;
  return String(candidate.promotion?.source_tenant_slug || '').trim() || null;
}

/** Minimal candidate shape for outcome linkage (also satisfiable by distill-candidate rows). */
export interface OutcomeLinkedCandidate {
  candidate_id: string;
  source_ref?: string;
  evidence_refs: Array<string | MemoryEvidenceRef>;
}

function normalizeOutcomeToken(value: unknown): string {
  return String(value ?? '').trim();
}

/**
 * D7: exact outcome-id equivalence for a candidate. Unlike substring matching
 * (work-design.ts resolveWorkDesign reusableRefs filter), this matches only:
 * candidate_id equality, source_ref equality (`mission:<id>` / `task_session:<id>`
 * prefixes included), or an evidence ref equal to the outcome id.
 * Summary text is deliberately never consulted.
 */
export function memoryCandidateMatchesOutcomeId(
  candidate: OutcomeLinkedCandidate,
  outcomeId: string
): boolean {
  const target = normalizeOutcomeToken(outcomeId);
  if (!target) return false;
  if (normalizeOutcomeToken(candidate.candidate_id) === target) return true;
  const sourceRef = normalizeOutcomeToken(candidate.source_ref);
  if (
    sourceRef === target ||
    sourceRef === `mission:${target}` ||
    sourceRef === `task_session:${target}`
  ) {
    return true;
  }
  return (candidate.evidence_refs || []).some((ref) => {
    try {
      const formatted = formatMemoryEvidenceRef(ref);
      return (
        formatted === target ||
        formatted === `artifact:${target}` ||
        formatted === `mission:${target}`
      );
    } catch {
      return false;
    }
  });
}

/** D7: filter candidates to those exactly linked to any of the given outcome ids. */
export function filterMemoryCandidatesByOutcomeIds<T extends OutcomeLinkedCandidate>(
  candidates: T[],
  outcomeIds: Array<string | undefined | null>
): T[] {
  const targets = new Set(
    (outcomeIds || []).map((id) => normalizeOutcomeToken(id)).filter(Boolean)
  );
  if (targets.size === 0) return [];
  return (candidates || []).filter((candidate) =>
    [...targets].some((id) => memoryCandidateMatchesOutcomeId(candidate, id))
  );
}

/**
 * D7: queue-side outcome lookup. Returns queued candidates exactly linked to the
 * outcome id (see memoryCandidateMatchesOutcomeId). work-design.ts uses memoryCandidateMatchesOutcomeId for exact reusable-ref
 * linkage; this helper provides the same rule for queue-side lookup.
 */
export function findMemoryPromotionCandidatesByOutcomeId(
  outcomeId: string,
  scope?: MemoryScopeEnvelope
): MemoryCandidate[] {
  return filterMemoryCandidatesByOutcomeIds(listMemoryPromotionCandidates(scope), [outcomeId]);
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
  if (candidate.knowledge_domain === 'product') {
    if (candidate.sensitivity_tier !== 'public' || candidate.scope) {
      throw new Error('Product knowledge requires a public, unscoped candidate.');
    }
    if (candidate.evidence_refs.some((ref) => !isPublicMemoryEvidencePath(ref))) {
      throw new Error(
        'Product knowledge requires evidence paths under knowledge/public or active/missions/public.'
      );
    }
  }
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

function readQueueRows(queuePath: string): MemoryCandidate[] {
  const safePath = assertSafeRepositoryPath(queuePath, { allowMissingLeaf: true });
  if (!safeExistsSync(safePath)) return [];
  if (!safeLstat(safePath).isFile()) {
    throw new Error(`[MEMORY_PROMOTION] queue must be a regular file: ${safePath}`);
  }
  return readJsonLines<MemoryCandidate>(safePath);
}

export function createMemoryPromotionCandidate(input: {
  candidateId?: string;
  sourceType: MemoryCandidateSourceType;
  sourceRef: string;
  knowledgeDomain?: MemoryKnowledgeDomain;
  proposedMemoryKind: MemoryCandidateKind;
  summary: string;
  evidenceRefs: Array<string | MemoryEvidenceRef>;
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
    ...(input.knowledgeDomain ? { knowledge_domain: input.knowledgeDomain } : {}),
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
  const now = normalizedCandidate.last_seen || normalizedCandidate.queued_at || nowIso();
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
      ...(current.knowledge_domain || normalizedCandidate.knowledge_domain
        ? { knowledge_domain: current.knowledge_domain || normalizedCandidate.knowledge_domain }
        : {}),
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
  if (!nextCandidate.audit_ref && getRegisteredEnvText('NODE_ENV') !== 'test') {
    try {
      const audit = auditChain.record({
        agentId: getRegisteredEnvText('KYBERION_AGENT_ID') || 'knowledge-promotion-queue',
        action: 'knowledge_promotion_candidate',
        operation: 'enqueue',
        result: 'completed',
        tenantSlug: getMemoryPromotionSourceTenant(nextCandidate) || undefined,
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
    .flatMap((queuePath) => readQueueRows(queuePath));
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
  knowledgeDomain?: MemoryKnowledgeDomain;
  ratificationNote?: string;
  promotedRef?: string;
  scope?: MemoryScopeEnvelope;
  /** Replace candidate scope during an explicit ownership/domain classification. */
  scopeUpdate?: MemoryScopeEnvelope;
  /** Update every physical duplicate in the selected scope. */
  allMatching?: boolean;
  /** FD-10 wave 1b: the human member who made this approve/reject decision. */
  decidedBy?: HumanDecidedBy;
  curation?: Omit<NonNullable<MemoryCandidate['curation']>, 'evidence_refs'> & {
    evidence_refs: MemoryEvidenceRefInput[];
  };
  /** KL-04: ratification channel recorded on approval. */
  approvalChannel?: MemoryApprovalChannel;
  /** KL-04: merge ratification observed at mission finish (pr_review channel). */
  ratification?: { ratifiedAt: string; ratifiedCommit: string; ratificationTarget: string };
}): MemoryCandidate | null {
  if (
    input.approvalChannel !== undefined &&
    !MEMORY_APPROVAL_CHANNELS.includes(input.approvalChannel)
  ) {
    throw new Error(
      `Unknown approval channel '${String(input.approvalChannel)}'; expected one of: ${MEMORY_APPROVAL_CHANNELS.join(', ')}.`
    );
  }
  const requestedScopeKey = input.scope ? resolveScopeKey(input.scope) : undefined;
  const candidateQueuePath = input.scope ? resolveQueuePath(input.scope) : undefined;
  const candidatePaths = input.allMatching
    ? queuePathsForAllScopes()
    : candidateQueuePath
      ? [candidateQueuePath]
      : queuePathsForAllScopes();
  const matchingQueuePaths = candidatePaths.filter((candidatePath) => {
    const rows = readQueueRows(candidatePath);
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
      readQueueRows(queuePath).filter((row) => row.candidate_id === input.candidateId)
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
    const rows = readQueueRows(queuePath);
    let changed = false;
    for (let index = 0; index < rows.length; index += 1) {
      const current = rows[index] as MemoryCandidate;
      if (
        current.candidate_id !== input.candidateId ||
        (requestedScopeKey && resolveScopeKey(current.scope) !== requestedScopeKey)
      ) {
        continue;
      }
      const requestedDomain = input.knowledgeDomain || current.knowledge_domain;
      // D7: tagged curation refs are normalized to the canonical string form before
      // the subset check; plain strings are compared verbatim (legacy behavior).
      const normalizedCurationRefs = input.curation
        ? input.curation.evidence_refs.map((ref) =>
            typeof ref === 'string' ? ref : formatMemoryEvidenceRef(ref)
          )
        : undefined;
      if (input.status === 'approved') {
        if (input.curation && normalizedCurationRefs) {
          const originalRefs = new Set(current.evidence_refs);
          if (
            normalizedCurationRefs.length === 0 ||
            normalizedCurationRefs.some((ref) => !originalRefs.has(ref))
          ) {
            throw new Error(
              'Curated evidence refs must be selected from the candidate original evidence refs.'
            );
          }
        }
        if (
          current.source_type === 'mission' &&
          (!requestedDomain || requestedDomain === 'unclassified')
        ) {
          throw new Error(
            'Mission memory candidates require an explicit knowledge domain before approval.'
          );
        }
        if (
          requestedDomain === 'product' &&
          (current.sensitivity_tier !== 'public' || current.scope)
        ) {
          throw new Error('Product knowledge approval requires a public, unscoped candidate.');
        }
        if (
          (input.approvalChannel || current.approval_channel) === 'pr_review' &&
          requestedDomain !== 'product'
        ) {
          throw new Error(
            'PR-review approval (approval_channel=pr_review) is only available for product knowledge; use the steward channel for organization/personal knowledge.'
          );
        }
        const effectiveScope = input.scopeUpdate || current.scope;
        if (
          requestedDomain === 'personal' &&
          (current.sensitivity_tier !== 'personal' || !effectiveScope?.owner_nhi?.trim())
        ) {
          throw new Error(
            'Personal knowledge approval requires personal tier and an explicit owner_nhi.'
          );
        }
      }
      // A pr_review candidate is ratified by the PR merge, not by approval or
      // promotion; its ratified_at is only written from input.ratification.
      const approvalChannel = input.approvalChannel || current.approval_channel;
      const deferRatification = approvalChannel === 'pr_review';
      const next: MemoryCandidate = {
        ...current,
        status: input.status,
        ...(input.curation && normalizedCurationRefs
          ? {
              curation: {
                title: input.curation.title,
                summary: input.curation.summary,
                content: input.curation.content,
                evidence_refs: normalizedCurationRefs,
              },
            }
          : {}),
        ...(input.knowledgeDomain ? { knowledge_domain: input.knowledgeDomain } : {}),
        ...(input.scopeUpdate
          ? { scope: assertMemoryScope(input.scopeUpdate, input.scopeUpdate.tier) }
          : {}),
        ...(input.approvalChannel ? { approval_channel: input.approvalChannel } : {}),
        ...(input.ratification
          ? {
              ratified_at: input.ratification.ratifiedAt,
              ratified_commit: input.ratification.ratifiedCommit,
              ratification_target: input.ratification.ratificationTarget,
            }
          : (input.status === 'approved' || input.status === 'promoted') && !deferRatification
            ? { ratified_at: ratifiedAt }
            : {}),
        ...(input.ratificationNote ? { ratification_note: input.ratificationNote.trim() } : {}),
        ...(input.promotedRef ? { promoted_ref: input.promotedRef.trim() } : {}),
        ...(input.decidedBy ? { decided_by: input.decidedBy } : {}),
      };
      assertPublicTierReferencesSafe(next);
      if (next.status === 'approved' && next.source_type === 'mission' && !next.curation) {
        throw new Error(
          'Mission memory candidates require a curated title, summary, content, and evidence refs before approval.'
        );
      }
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
  evidenceRefs: Array<string | MemoryEvidenceRef>;
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
