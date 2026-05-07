import {
  createDistillCandidateRecord,
  saveDistillCandidateRecord,
  type DistillCandidateRecord,
  updateDistillCandidateRecord,
} from './distill-candidate-registry.js';
import {
  loadMemoryPromotionCandidate,
  type MemoryCandidate,
  updateMemoryPromotionCandidateStatus,
} from './memory-promotion-queue.js';
import { savePromotedMemoryRecord, NotMeaningfulPromotionCandidateError } from './promoted-memory.js';
import { logger } from './core.js';

type PromotedMemoryExecutionRole = 'mission_controller' | 'chronos_gateway';

function mapMemoryKindToDistillTarget(kind: MemoryCandidate['proposed_memory_kind']): DistillCandidateRecord['target_kind'] {
  switch (kind) {
    case 'sop':
      return 'sop_candidate';
    case 'template':
      return 'report_template';
    case 'heuristic':
      return 'knowledge_hint';
    case 'risk_rule':
      return 'pattern';
    case 'clarification_prompt':
      return 'knowledge_hint';
  }
}

function normalizeTier(tier: MemoryCandidate['sensitivity_tier']): DistillCandidateRecord['tier'] {
  if (tier === 'personal' || tier === 'public') return tier;
  return 'confidential';
}

function parseSourceRef(sourceRef: string): {
  missionId?: string;
  taskSessionId?: string;
  artifactIds?: string[];
} {
  const trimmed = String(sourceRef || '').trim();
  if (!trimmed) return {};
  if (trimmed.startsWith('mission:')) {
    return { missionId: trimmed.replace(/^mission:/u, '').trim() || undefined };
  }
  if (trimmed.startsWith('task_session:')) {
    return { taskSessionId: trimmed.replace(/^task_session:/u, '').trim() || undefined };
  }
  if (trimmed.startsWith('artifact:')) {
    const artifactId = trimmed.replace(/^artifact:/u, '').trim();
    return artifactId ? { artifactIds: [artifactId] } : {};
  }
  if (trimmed.startsWith('heuristic:')) {
    return {};
  }
  return {};
}

function toDistillSourceType(sourceType: MemoryCandidate['source_type']): DistillCandidateRecord['source_type'] {
  if (sourceType === 'mission') return 'mission';
  if (sourceType === 'task_session') return 'task_session';
  return 'artifact';
}

function buildPromotionMetadata(candidate: MemoryCandidate): Record<string, unknown> {
  const base = {
    memory_candidate_source_ref: candidate.source_ref,
    memory_candidate_kind: candidate.proposed_memory_kind,
    memory_ratification_required: candidate.ratification_required,
  };
  switch (candidate.proposed_memory_kind) {
    case 'sop':
      return {
        ...base,
        procedure_steps: [candidate.summary],
      };
    case 'template':
      return {
        ...base,
        template_sections: [candidate.summary],
      };
    case 'risk_rule':
      return {
        ...base,
        applicability: [candidate.source_type, candidate.source_ref],
        expected_outcome: candidate.summary,
      };
    case 'heuristic':
    case 'clarification_prompt':
      return {
        ...base,
        hint_scope: candidate.source_type,
        hint_triggers: [candidate.summary],
      };
  }
}

function buildDistillCandidateFromMemoryCandidate(candidate: MemoryCandidate): DistillCandidateRecord {
  const sourceRefParts = parseSourceRef(candidate.source_ref);
  return createDistillCandidateRecord({
    candidate_id: candidate.candidate_id,
    source_type: toDistillSourceType(candidate.source_type),
    tier: normalizeTier(candidate.sensitivity_tier),
    mission_id: sourceRefParts.missionId,
    task_session_id: sourceRefParts.taskSessionId,
    artifact_ids: sourceRefParts.artifactIds,
    title: candidate.summary.slice(0, 80) || `Memory candidate ${candidate.candidate_id}`,
    summary: candidate.summary,
    status: 'proposed',
    target_kind: mapMemoryKindToDistillTarget(candidate.proposed_memory_kind),
    evidence_refs: candidate.evidence_refs,
    metadata: buildPromotionMetadata(candidate),
  });
}

export function promoteMemoryCandidateToKnowledge(input: {
  candidateId: string;
  executionRole?: PromotedMemoryExecutionRole;
  ratificationNote?: string;
}): { candidate: MemoryCandidate; promotedRef: string } {
  const candidateId = String(input.candidateId || '').trim();
  if (!candidateId) throw new Error('candidateId is required.');
  const candidate = loadMemoryPromotionCandidate(candidateId);
  if (!candidate) throw new Error(`Memory promotion candidate not found: ${candidateId}`);
  if (candidate.status === 'rejected') {
    throw new Error(`Memory promotion candidate ${candidateId} is rejected and cannot be promoted.`);
  }
  if (candidate.status === 'promoted') {
    return {
      candidate,
      promotedRef: candidate.promoted_ref || '',
    };
  }
  if (candidate.ratification_required && candidate.status !== 'approved') {
    throw new Error(`Memory promotion candidate ${candidateId} requires ratification before promotion.`);
  }
  if ((candidate.evidence_refs || []).length === 0) {
    throw new Error(`Memory promotion candidate ${candidateId} requires evidence_refs for promotion.`);
  }

  const distillCandidate = buildDistillCandidateFromMemoryCandidate(candidate);
  saveDistillCandidateRecord(distillCandidate);
  let promoted;
  try {
    promoted = savePromotedMemoryRecord(distillCandidate, {
      executionRole: input.executionRole || 'mission_controller',
    });
  } catch (err) {
    // The candidate failed the value threshold (e.g. test track, generic title,
    // missing metadata). Mark it rejected rather than promoted so the queue
    // does not silently accumulate fallback-shaped records under
    // knowledge/.../generated/.
    if (err instanceof NotMeaningfulPromotionCandidateError) {
      logger.info(
        `[memory-promotion] Skipped promotion of ${distillCandidate.candidate_id}: ${err.reason}`,
      );
      // Distill candidate has no 'rejected' status — use 'archived' to mark
      // that it is no longer in the promotion pipeline.
      updateDistillCandidateRecord(distillCandidate.candidate_id, {
        status: 'archived',
        promoted_ref: '',
      });
      updateMemoryPromotionCandidateStatus({
        candidateId: distillCandidate.candidate_id,
        status: 'rejected',
        ratificationNote: `Promotion suppressed: ${err.reason}`,
        promotedRef: '',
      });
      const rejected = loadMemoryPromotionCandidate(candidateId);
      if (!rejected) throw new Error(`Rejected candidate disappeared from queue: ${candidateId}`);
      return { candidate: rejected, promotedRef: '' };
    }
    throw err;
  }
  updateDistillCandidateRecord(distillCandidate.candidate_id, {
    status: 'promoted',
    promoted_ref: promoted.logicalPath,
  });
  updateMemoryPromotionCandidateStatus({
    candidateId: distillCandidate.candidate_id,
    status: 'promoted',
    ratificationNote: input.ratificationNote || 'Promoted to governed knowledge.',
    promotedRef: promoted.logicalPath,
  });
  const updated = loadMemoryPromotionCandidate(candidateId);
  if (!updated) throw new Error(`Promoted candidate disappeared from queue: ${candidateId}`);
  return {
    candidate: updated,
    promotedRef: promoted.logicalPath,
  };
}
