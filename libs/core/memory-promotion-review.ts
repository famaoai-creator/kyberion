import * as path from 'node:path';
import { auditChain } from './audit-chain.js';
import { assertMemoryScope } from './memory-scope.js';
import {
  listMemoryPromotionCandidates,
  memoryPromotionScopeKey,
  type MemoryCandidate,
} from './memory-promotion-queue.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync } from './secure-io.js';

export type MemoryPromotionReviewStatus =
  'ready_to_approve' | 'ready_to_promote' | 'hold' | 'promoted' | 'rejected';

export type MemoryPromotionReviewBlockerCode =
  | 'missing_audit_ref'
  | 'missing_audit_entry'
  | 'audit_tenant_mismatch'
  | 'missing_evidence'
  | 'missing_tenant_scope'
  | 'invalid_scope'
  | 'duplicate_records'
  | 'conflicting_records';

export interface MemoryPromotionEvidenceReview {
  ref: string;
  kind: 'logical' | 'path';
  status: 'logical' | 'present' | 'missing';
  resolved_path?: string;
}

export interface MemoryPromotionAuditReview {
  ref?: string;
  audit_id?: string;
  status: 'missing_ref' | 'missing_entry' | 'present' | 'tenant_mismatch';
  tenant_slug?: string;
}

export interface MemoryPromotionReview {
  candidate: MemoryCandidate;
  candidate_id: string;
  review_status: MemoryPromotionReviewStatus;
  approval_required: boolean;
  target_kind: 'pattern' | 'sop_candidate' | 'knowledge_hint' | 'report_template';
  target_path: string;
  scope_key: string;
  physical_record_count: number;
  duplicate_count: number;
  queue_statuses: MemoryCandidate['status'][];
  record_conflicts: string[];
  evidence: MemoryPromotionEvidenceReview[];
  audit: MemoryPromotionAuditReview;
  blockers: Array<{ code: MemoryPromotionReviewBlockerCode; detail: string }>;
  warnings: string[];
}

function scopeKey(candidate: MemoryCandidate): string {
  try {
    return memoryPromotionScopeKey(candidate.scope);
  } catch {
    // Keep malformed records inspectable so buildReview can report invalid_scope.
    return JSON.stringify({ invalid_scope: candidate.scope || null });
  }
}

function groupKey(candidate: MemoryCandidate): string {
  return `${candidate.candidate_id}\u0000${scopeKey(candidate)}`;
}

function targetKind(candidate: MemoryCandidate): MemoryPromotionReview['target_kind'] {
  switch (candidate.proposed_memory_kind) {
    case 'sop':
      return 'sop_candidate';
    case 'template':
      return 'report_template';
    case 'heuristic':
    case 'clarification_prompt':
      return 'knowledge_hint';
    case 'risk_rule':
      return 'pattern';
    case 'archive_advisory':
      return 'knowledge_hint';
  }
}

function targetDirectory(
  candidate: MemoryCandidate,
  kind: MemoryPromotionReview['target_kind']
): string {
  const tenant = candidate.scope?.tier === 'confidential' ? candidate.scope.tenant_slug : undefined;
  const kindDir =
    kind === 'pattern'
      ? 'patterns'
      : kind === 'sop_candidate'
        ? 'operations'
        : kind === 'knowledge_hint'
          ? 'wisdom'
          : 'templates';
  if (tenant) return `knowledge/confidential/${tenant}/evolution/${kindDir}`;
  return `knowledge/${candidate.sensitivity_tier}/common/${kindDir}/generated`;
}

function isLogicalEvidenceRef(ref: string): boolean {
  return /^(mission|task_session|artifact|deliverable):/u.test(ref.trim());
}

function reviewEvidence(candidate: MemoryCandidate): MemoryPromotionEvidenceReview[] {
  return candidate.evidence_refs.map((rawRef) => {
    const ref = String(rawRef || '').trim();
    if (isLogicalEvidenceRef(ref)) return { ref, kind: 'logical', status: 'logical' };
    const resolvedPath = path.isAbsolute(ref) ? ref : pathResolver.rootResolve(ref);
    return {
      ref,
      kind: 'path',
      status: safeExistsSync(resolvedPath) ? 'present' : 'missing',
      resolved_path: resolvedPath,
    };
  });
}

function reviewAudit(candidate: MemoryCandidate): MemoryPromotionAuditReview {
  if (!candidate.audit_ref) return { status: 'missing_ref' };
  const auditId = candidate.audit_ref.replace(/^audit:/u, '');
  const entries =
    typeof (auditChain as any).loadAll === 'function'
      ? ((auditChain as any).loadAll() as Array<{
          id?: string;
          tenantSlug?: string;
          scope?: { tenant_slug?: string };
        }>)
      : [];
  const entry = entries.find((item) => item.id === auditId);
  if (!entry) return { ref: candidate.audit_ref, audit_id: auditId, status: 'missing_entry' };
  const entryTenantSlug = entry.tenantSlug || entry.scope?.tenant_slug;
  if (candidate.scope?.tenant_slug && entryTenantSlug !== candidate.scope.tenant_slug) {
    return {
      ref: candidate.audit_ref,
      audit_id: auditId,
      status: 'tenant_mismatch',
      tenant_slug: entryTenantSlug,
    };
  }
  return {
    ref: candidate.audit_ref,
    audit_id: auditId,
    status: 'present',
    ...(entryTenantSlug ? { tenant_slug: entryTenantSlug } : {}),
  };
}

function recordShape(candidate: MemoryCandidate): Record<string, unknown> {
  return {
    source_type: candidate.source_type,
    source_ref: candidate.source_ref,
    proposed_memory_kind: candidate.proposed_memory_kind,
    summary: candidate.summary,
    evidence_refs: [...candidate.evidence_refs].sort(),
    sensitivity_tier: candidate.sensitivity_tier,
    ratification_required: candidate.ratification_required,
    audit_ref: candidate.audit_ref || null,
    promotion: candidate.promotion || null,
  };
}

function findRecordConflicts(group: MemoryCandidate[]): string[] {
  if (group.length < 2) return [];
  const baseline = recordShape(group[0]);
  const conflicts = new Set<string>();
  for (const candidate of group.slice(1)) {
    const current = recordShape(candidate);
    for (const key of Object.keys(baseline)) {
      if (JSON.stringify(baseline[key]) !== JSON.stringify(current[key])) conflicts.add(key);
    }
  }
  return Array.from(conflicts).sort();
}

function buildReview(candidate: MemoryCandidate, group: MemoryCandidate[]): MemoryPromotionReview {
  const blockers: MemoryPromotionReview['blockers'] = [];
  const warnings: string[] = [];
  const evidence = reviewEvidence(candidate);
  const audit = reviewAudit(candidate);
  const kind = targetKind(candidate);
  const targetPath = `${targetDirectory(candidate, kind)}/${candidate.candidate_id}.md`;
  const recordConflicts = findRecordConflicts(group);

  if (audit.status === 'missing_ref') {
    blockers.push({
      code: 'missing_audit_ref',
      detail: 'The candidate has no audit reference; enqueue it through the governed path again.',
    });
  } else if (audit.status === 'missing_entry') {
    blockers.push({
      code: 'missing_audit_entry',
      detail: `Audit entry ${audit.audit_id} is not present in the current audit chain.`,
    });
  } else if (audit.status === 'tenant_mismatch') {
    blockers.push({
      code: 'audit_tenant_mismatch',
      detail: `The audit tenant (${audit.tenant_slug || 'none'}) does not match the candidate scope.`,
    });
  }

  const missingEvidence = evidence.filter((item) => item.status === 'missing');
  if (missingEvidence.length > 0) {
    blockers.push({
      code: 'missing_evidence',
      detail: `${missingEvidence.length} evidence reference(s) are missing.`,
    });
  }

  if (!candidate.scope) {
    if (candidate.sensitivity_tier === 'confidential') {
      blockers.push({
        code: 'missing_tenant_scope',
        detail: 'A confidential candidate must include a tenant scope.',
      });
    } else {
      warnings.push(
        'Legacy candidate without a scope envelope; verify provenance before publication.'
      );
    }
  } else {
    try {
      assertMemoryScope(candidate.scope, candidate.scope.tier);
    } catch (error) {
      blockers.push({
        code: 'invalid_scope',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (group.length > 1) {
    blockers.push({
      code: 'duplicate_records',
      detail: `${group.length} physical records share the same candidate and scope.`,
    });
  }
  if (recordConflicts.length > 0) {
    blockers.push({
      code: 'conflicting_records',
      detail: `Duplicate records disagree on: ${recordConflicts.join(', ')}`,
    });
  }

  if (
    !candidate.source_ref.startsWith('mission:') &&
    !candidate.source_ref.startsWith('task_session:')
  ) {
    warnings.push('Legacy source_ref without a type prefix.');
  }

  const statuses = Array.from(new Set(group.map((row) => row.status)));
  let reviewStatus: MemoryPromotionReviewStatus;
  if (candidate.status === 'promoted') reviewStatus = 'promoted';
  else if (candidate.status === 'rejected') reviewStatus = 'rejected';
  else if (blockers.length > 0) reviewStatus = 'hold';
  else if (candidate.status === 'approved' || !candidate.ratification_required) {
    reviewStatus = 'ready_to_promote';
  } else {
    reviewStatus = 'ready_to_approve';
  }

  return {
    candidate,
    candidate_id: candidate.candidate_id,
    review_status: reviewStatus,
    approval_required: candidate.ratification_required,
    target_kind: kind,
    target_path: targetPath,
    scope_key: scopeKey(candidate),
    physical_record_count: group.length,
    duplicate_count: Math.max(0, group.length - 1),
    queue_statuses: statuses,
    record_conflicts: recordConflicts,
    evidence,
    audit,
    blockers,
    warnings,
  };
}

export function reviewMemoryPromotionQueue(
  status?: MemoryCandidate['status']
): MemoryPromotionReview[] {
  const allCandidates = listMemoryPromotionCandidates();
  const groups = new Map<string, MemoryCandidate[]>();
  for (const candidate of allCandidates) {
    const key = groupKey(candidate);
    const group = groups.get(key) || [];
    group.push(candidate);
    groups.set(key, group);
  }
  return Array.from(groups.values())
    .filter((group) => !status || group.some((candidate) => candidate.status === status))
    .map((group) => {
      const representative =
        (status ? group.find((candidate) => candidate.status === status) : undefined) ||
        [...group].sort((a, b) => b.queued_at.localeCompare(a.queued_at))[0];
      return buildReview(representative, group);
    })
    .sort((a, b) => b.candidate.queued_at.localeCompare(a.candidate.queued_at));
}

export function reviewMemoryPromotionCandidate(candidateId: string): MemoryPromotionReview[] {
  return reviewMemoryPromotionQueue().filter((review) => review.candidate_id === candidateId);
}

export function assertMemoryPromotionReviewReady(
  review: MemoryPromotionReview,
  operation: 'approve' | 'promote'
): void {
  if (review.blockers.length > 0) {
    throw new Error(
      `[MEMORY_PROMOTION_HOLD] ${review.candidate_id} cannot ${operation}: ${review.blockers
        .map((blocker) => `${blocker.code}=${blocker.detail}`)
        .join('; ')}`
    );
  }
  if (
    operation === 'promote' &&
    review.approval_required &&
    review.candidate.status !== 'approved'
  ) {
    throw new Error(
      `[MEMORY_PROMOTION_HOLD] ${review.candidate_id} requires memory-approve before memory-promote.`
    );
  }
}
