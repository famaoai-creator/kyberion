import type { MemoryCandidate } from '@agent/core/knowledge/memory-promotion-queue';
import { inspectScopedLearningReview } from '@agent/core/knowledge/scoped-learning-workflow';
import { memoryCandidateKey } from './memory-candidate-selection';
import { resolveMemoryCandidateTenant } from './knowledge-scope';

export function projectKnowledgeCandidate(candidate: MemoryCandidate) {
  const inspected =
    candidate.scope && candidate.proposed_memory_kind === 'sop'
      ? inspectScopedLearningReview(candidate)
      : undefined;
  // The inspector reloads the same exact identity; keep its state and payload together.
  if (inspected) candidate = inspected.candidate;
  // Internal inspector diagnostics remain available to CLI callers, never HTTP.
  const review = inspected?.learning;
  const learning = review
    ? {
        state: review.state,
        ...(review.payloadDigest ? { payloadDigest: review.payloadDigest } : {}),
        ...(review.approvalRef ? { approvalRef: review.approvalRef } : {}),
        ...(review.publication ? { publication: review.publication } : {}),
        ...(review.reuse ? { reuse: review.reuse } : {}),
        ...(review.reuseUnavailable ? { reuseUnavailable: true } : {}),
      }
    : undefined;
  return {
    candidate_id: candidate.candidate_id,
    candidateKey: memoryCandidateKey(candidate),
    status: candidate.status,
    proposed_memory_kind: candidate.proposed_memory_kind,
    summary: candidate.summary,
    evidence_refs: candidate.evidence_refs,
    sensitivity_tier: candidate.sensitivity_tier,
    source_ref: candidate.source_ref,
    tenantSlug: resolveMemoryCandidateTenant(candidate),
    ratification_required: candidate.ratification_required,
    ...(candidate.scope ? { scope: candidate.scope } : {}),
    ...(candidate.curation ? { curation: candidate.curation } : {}),
    ...(candidate.promoted_ref ? { promoted_ref: candidate.promoted_ref } : {}),
    ...(learning ? { learning } : {}),
  };
}
