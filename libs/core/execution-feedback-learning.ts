/** Read-only learning evidence and explicit handoff to the existing memory workflow.
 * Never decides a human review, invokes a model, or edits the procedure catalog.
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { assertMemoryScope, type MemoryScopeEnvelope } from './knowledge/memory-scope.js';
import {
  executionFeedbackScopeKey,
  executionFeedbackCandidatePath,
  loadExecutionFeedbackCandidate,
  saveExecutionFeedbackCandidate,
} from './execution-feedback-candidates.js';
import { type DistillCandidateRecord } from './knowledge/distill-candidate-registry.js';
import {
  createMemoryPromotionCandidate,
  enqueueMemoryPromotionCandidate,
  loadMemoryPromotionCandidate,
  type MemoryCandidate,
} from './knowledge/memory-promotion-queue.js';

interface LearningLink {
  candidate_id: string;
  source_digest: string;
  queue_digest: string;
}
export interface ExecutionFeedbackLearningReview {
  candidate_id: string;
  candidate_status: DistillCandidateRecord['status'];
  scope_disposition: 'canonical' | 'legacy_unscoped';
  queue: { status: 'not_queued' | 'invalid' | MemoryCandidate['status']; candidate_id?: string };
  human_review: { status: 'pending' | 'recorded' | 'rejected' | 'unverified'; decided_by?: string };
  promotion: { status: 'none' | 'unverified'; reference?: string };
  retrieval: { status: 'unmeasured' };
  blockers: string[];
  next_action: string;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function sourceDigest(row: DistillCandidateRecord): string {
  return digest({
    id: row.candidate_id,
    title: row.title,
    summary: row.summary,
    tier: row.tier,
    scope: executionFeedbackScopeKey(row.scope),
    evidence: [...(row.evidence_refs || [])].sort(),
    procedure: row.metadata?.procedure_id || null,
  });
}
function queueDigest(row: MemoryCandidate): string {
  return digest({
    id: row.candidate_id,
    source_type: row.source_type,
    source_ref: row.source_ref,
    kind: row.proposed_memory_kind,
    domain: row.knowledge_domain,
    summary: row.summary,
    evidence: [...row.evidence_refs].sort(),
    tier: row.sensitivity_tier,
    scope: executionFeedbackScopeKey(row.scope),
    ratification_required: row.ratification_required,
  });
}
function loadCandidate(id: string, scope?: MemoryScopeEnvelope): DistillCandidateRecord {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(id))
    throw new Error('[FEEDBACK_CANDIDATE_INVALID] Invalid candidate id');
  const row = loadExecutionFeedbackCandidate(id, scope);
  if (!row || row.metadata?.improvement_kind !== 'execution_feedback')
    throw new Error('[FEEDBACK_CANDIDATE_NOT_FOUND] Candidate not found');
  if (executionFeedbackScopeKey(row.scope) !== executionFeedbackScopeKey(scope)) {
    throw new Error('[FEEDBACK_SCOPE_MISMATCH] Candidate scope does not match the selected scope');
  }
  return row;
}
function linkFor(row: DistillCandidateRecord): LearningLink | undefined {
  const value = row.metadata?.learning_link;
  if (!value || typeof value !== 'object') return undefined;
  const link = value as Partial<LearningLink>;
  if (
    typeof link.candidate_id !== 'string' ||
    !/^MEM-FB-[a-f0-9]{32}$/.test(link.candidate_id) ||
    typeof link.source_digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(link.source_digest) ||
    typeof link.queue_digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(link.queue_digest)
  )
    return undefined;
  return link as LearningLink;
}

function unsupportedPromotionScope(scope?: MemoryScopeEnvelope): string[] {
  if (!scope) return ['legacy_unscoped'];
  const canonical = assertMemoryScope(scope);
  const unsupported = Object.keys(canonical).filter(
    (key) => key !== 'tier' && key !== 'tenant_slug'
  );
  if (canonical.tier !== 'confidential') unsupported.push('tier');
  if (!canonical.tenant_slug) unsupported.push('tenant_slug');
  return unsupported;
}

export function inspectExecutionFeedbackLearning(
  id: string,
  scope?: MemoryScopeEnvelope
): ExecutionFeedbackLearningReview {
  const row = loadCandidate(id, scope);
  const result: ExecutionFeedbackLearningReview = {
    candidate_id: id,
    candidate_status: row.status,
    scope_disposition: row.scope ? 'canonical' : 'legacy_unscoped',
    queue: { status: row.metadata?.learning_link ? 'invalid' : 'not_queued' },
    human_review: { status: 'pending' },
    promotion: { status: row.status === 'promoted' || row.promoted_ref ? 'unverified' : 'none' },
    retrieval: { status: 'unmeasured' },
    blockers: [],
    next_action:
      'Review the proposal; queue explicitly before a human decision. No procedure was applied.',
  };
  if (!row.scope) {
    result.blockers.push('legacy_scope_requires_explicit_classification');
    result.next_action =
      'Legacy unscoped proposal: review only. Re-submit feedback in an explicitly selected scope; this record will not be adopted or queued implicitly.';
    return result;
  }
  const unsupported = unsupportedPromotionScope(row.scope);
  if (row.scope && unsupported.length) {
    result.blockers.push('promotion_scope_not_preserved:' + unsupported.join(','));
    result.next_action =
      'The existing publisher cannot preserve these scope fields: ' +
      unsupported.join(', ') +
      '. Keep this proposal in read-only review; a scope-preserving promotion route is required. Scope will not be reduced automatically.';
    return result;
  }
  const link = linkFor(row);
  if (!link) {
    if (row.metadata?.learning_link) {
      result.queue.status = 'invalid';
      result.blockers.push('invalid_learning_link');
    }
    return result;
  }
  result.queue = { status: 'invalid', candidate_id: link.candidate_id };
  if (sourceDigest(row) !== link.source_digest) {
    result.blockers.push('source_digest_mismatch');
    return result;
  }
  const queued = loadMemoryPromotionCandidate(link.candidate_id, scope);
  if (!queued) {
    result.blockers.push('linked_candidate_missing');
    return result;
  }
  if (
    executionFeedbackScopeKey(queued.scope) !== executionFeedbackScopeKey(row.scope) ||
    queueDigest(queued) !== link.queue_digest
  ) {
    result.blockers.push('queue_digest_or_scope_mismatch');
    return result;
  }
  result.queue.status = queued.status;
  if (
    queued.status === 'approved' ||
    queued.status === 'promoted' ||
    queued.status === 'rejected'
  ) {
    const human = queued.decided_by;
    result.human_review =
      human?.kind === 'human' &&
      /^user:.+/.test(human.id) &&
      (queued.status === 'rejected' || Boolean(queued.ratified_at))
        ? { status: queued.status === 'rejected' ? 'rejected' : 'recorded', decided_by: human.id }
        : { status: 'unverified' };
  }
  result.next_action =
    'Use the existing human memory review, then the governed memory promotion. Publication does not mean retrieval or execution.';
  if (queued.status === 'rejected') {
    result.blockers.push('human_review_rejected');
    result.next_action =
      'This proposal was rejected. Keep it unchanged; submit revised feedback for a separate review if needed. Do not promote the rejected proposal.';
    return result;
  }
  if (queued.status !== 'promoted') return result;
  result.promotion = {
    status: 'unverified',
    ...(queued.promoted_ref ? { reference: queued.promoted_ref } : {}),
  };
  // Existing publication files do not bind the full scope/content, and usage
  // aggregates merge scopes. Neither is exact evidence for this proposal.
  result.blockers.push('exact_publication_proof_unavailable');
  result.next_action =
    'A promotion reference is recorded, but exact scoped publication and retrieval evidence remain unverified. Review the governed promotion artifacts separately; no procedure application is claimed.';
  return result;
}

export function queueExecutionFeedbackLearning(
  id: string,
  scope?: MemoryScopeEnvelope
): ExecutionFeedbackLearningReview {
  const row = loadCandidate(id, scope);
  if (!row.scope)
    throw new Error(
      '[FEEDBACK_SCOPE_REQUIRED] Explicit classification is required for legacy candidates; scope is never inferred'
    );
  const canonical = assertMemoryScope(row.scope);
  const unsupported = unsupportedPromotionScope(canonical);
  if (unsupported.length)
    throw new Error(
      '[FEEDBACK_PROMOTION_SCOPE_UNSUPPORTED] Existing publisher cannot preserve: ' +
        unsupported.join(', ')
    );
  if (row.tier !== canonical.tier)
    throw new Error('[FEEDBACK_SCOPE_MISMATCH] Candidate tier differs from scope');
  if (row.metadata?.learning_link) {
    const review = inspectExecutionFeedbackLearning(id, scope);
    if (review.queue.status === 'invalid')
      throw new Error('[FEEDBACK_LINK_INVALID] ' + review.blockers.join(', '));
    return review;
  }
  if (row.status !== 'proposed')
    throw new Error('[FEEDBACK_NOT_PROPOSED] Only a proposed candidate can be queued');
  const source = sourceDigest(row);
  const queueId = 'MEM-FB-' + digest({ id, source }).slice(0, 32);
  const evidence = path
    .relative(pathResolver.rootDir(), executionFeedbackCandidatePath(id, canonical))
    .replaceAll('\\', '/');
  const expected = createMemoryPromotionCandidate({
    candidateId: queueId,
    sourceType: 'task_session',
    sourceRef: 'task_session:' + id,
    knowledgeDomain: 'organization',
    proposedMemoryKind: 'sop',
    summary: row.summary,
    evidenceRefs: [evidence],
    sensitivityTier: canonical.tier,
    scope: canonical,
    ratificationRequired: true,
    queuedAt: row.created_at,
  });
  const existing = loadMemoryPromotionCandidate(queueId, canonical);
  if (
    existing &&
    (existing.status !== 'queued' || queueDigest(existing) !== queueDigest(expected))
  ) {
    throw new Error('[FEEDBACK_LINK_INVALID] Existing queue identity does not match this proposal');
  }
  if (!existing) enqueueMemoryPromotionCandidate(expected);
  const queued = loadMemoryPromotionCandidate(queueId, canonical);
  if (!queued || queueDigest(queued) !== queueDigest(expected))
    throw new Error('[FEEDBACK_LINK_INVALID] Queue persistence did not match the proposal');
  saveExecutionFeedbackCandidate({
    ...row,
    metadata: {
      ...row.metadata,
      learning_link: {
        candidate_id: queueId,
        source_digest: source,
        queue_digest: queueDigest(queued),
      },
    },
  });
  return inspectExecutionFeedbackLearning(id, scope);
}
