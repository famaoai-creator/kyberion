/** Exact-scope SOP publication contract. Learning never conveys execution authority. */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { assertMemoryScope, type MemoryScopeEnvelope } from './memory-scope.js';
import { assertPhysicalScopeSegment } from '../physical-namespace.js';
import { knowledgeWritePathFor } from './knowledge-scope.js';
import type { MemoryCandidate } from './memory-promotion-queue.js';
import type { HumanDecidedBy } from '../mission/mission-types.js';

export interface ScopedLearningApproval {
  version: 1;
  payload_digest: string;
  approval_ref: string;
  decided_by: HumanDecidedBy;
  approved_at: string;
  channel: 'steward';
}
export interface ScopedLearningPublicationIdentity {
  version: 1;
  candidate_id: string;
  scope: MemoryScopeEnvelope;
  approved_payload_digest: string;
  record_path: string;
  markdown_path: string;
  record_sha256: string;
  markdown_sha256: string;
}
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
