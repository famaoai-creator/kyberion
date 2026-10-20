/** Exact-scope learning validation, identity and paths; no execution authority. */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { assertMemoryScope, type MemoryScopeEnvelope } from './memory-scope.js';
import { assertPhysicalScopeSegment } from '../physical-namespace.js';
import { knowledgeWritePathFor } from './knowledge-scope.js';
import type { MemoryCandidate } from './memory-promotion-queue.js';
export type {
  ScopedLearningApproval,
  ScopedLearningPublicationIdentity,
} from './scoped-learning-contract.js';

export function assertScopedLearningScope(scope: MemoryScopeEnvelope): MemoryScopeEnvelope {
  const allowed = new Set(['tier', 'tenant_slug', 'organization_id', 'project_id']);
  if (Object.entries(scope).some(([key, value]) => value !== undefined && !allowed.has(key)))
    throw new Error(
      '[LEARNING_SCOPE_UNSUPPORTED] Only exact tenant, organization or project scopes are supported'
    );
  const canonical = assertMemoryScope(scope);
  if (canonical.tier !== 'confidential' || !canonical.tenant_slug)
    throw new Error('[LEARNING_SCOPE_UNSUPPORTED] Confidential tenant scope is required');
  for (const key of ['organization_id', 'project_id'] as const) {
    if (canonical[key]) assertPhysicalScopeSegment(canonical[key], key);
  }
  scopedLearningMarkdownPathUnchecked(canonical, 'scope-validation');
  return canonical;
}
function scopedLearningMarkdownPathUnchecked(scope: MemoryScopeEnvelope, id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(id))
    throw new Error('[LEARNING_ID_INVALID] Invalid candidate id');
  const level = scope.project_id ? 'project' : scope.organization_id ? 'organization' : 'tenant';
  const parent = path.posix.dirname(knowledgeWritePathFor(scope, level, id));
  return path.posix.join('knowledge', parent, 'evolution', 'operations', id + '.md');
}
export function scopedLearningMarkdownPath(scope: MemoryScopeEnvelope, id: string): string {
  return scopedLearningMarkdownPathUnchecked(assertScopedLearningScope(scope), id);
}
/** Reject caller-altered receipt identity before any historical publication read. */
export function assertScopedLearningPublicationReferences(candidate: MemoryCandidate): void {
  const scope = assertScopedLearningScope(candidate.scope!);
  const markdownPath = scopedLearningMarkdownPath(scope, candidate.candidate_id);
  if (candidate.promoted_ref !== undefined && candidate.promoted_ref !== markdownPath)
    throw new Error('[LEARNING_PUBLICATION_INVALID] Unexpected publication reference');
  const publication = candidate.learning_publication;
  // An approved queue row may have no receipt after a publisher/queue crash.
  // The subsequent canonical readback is what establishes its new receipt.
  if (!publication) return;
  if (
    publication.version !== 1 ||
    publication.candidate_id !== candidate.candidate_id ||
    JSON.stringify(assertScopedLearningScope(publication.scope)) !== JSON.stringify(scope) ||
    publication.approved_payload_digest !== approvedLearningPayloadDigest(candidate) ||
    publication.markdown_path !== markdownPath ||
    publication.record_path !== markdownPath.replace(/\.md$/, '.json') ||
    !/^[a-f0-9]{64}$/.test(publication.markdown_sha256) ||
    !/^[a-f0-9]{64}$/.test(publication.record_sha256)
  )
    throw new Error('[LEARNING_PUBLICATION_INVALID] Receipt identity differs from candidate');
}
export function isScopedLearningCandidate(candidate: MemoryCandidate): boolean {
  return Boolean(
    candidate.scope &&
    candidate.knowledge_domain === 'organization' &&
    candidate.proposed_memory_kind === 'sop'
  );
}
export const learningSha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
export function approvedLearningPayloadDigest(candidate: MemoryCandidate): string {
  if (
    !candidate.scope ||
    !isScopedLearningCandidate(candidate) ||
    candidate.sensitivity_tier !== 'confidential' ||
    candidate.promotion
  )
    throw new Error(
      '[LEARNING_SCOPE_UNSUPPORTED] Only same-scope confidential organization SOPs are supported'
    );
  return learningSha256(
    JSON.stringify({
      version: 1,
      candidate_id: candidate.candidate_id,
      source_type: candidate.source_type,
      source_ref: candidate.source_ref,
      knowledge_domain: candidate.knowledge_domain,
      proposed_memory_kind: candidate.proposed_memory_kind,
      summary: candidate.summary,
      evidence_refs: candidate.evidence_refs,
      sensitivity_tier: candidate.sensitivity_tier,
      scope: assertScopedLearningScope(candidate.scope),
      ratification_required: candidate.ratification_required,
      curation: candidate.curation
        ? {
            title: candidate.curation.title,
            summary: candidate.curation.summary,
            content: candidate.curation.content,
            evidence_refs: candidate.curation.evidence_refs,
          }
        : null,
      distill_experience: candidate.distill_experience ?? null,
      distill_experience_declined: candidate.distill_experience_declined ?? null,
    })
  );
}
