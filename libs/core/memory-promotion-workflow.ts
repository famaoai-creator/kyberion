import {
  createDistillCandidateRecord,
  loadDistillCandidateRecord,
  saveDistillCandidateRecord,
  type DistillCandidateRecord,
  updateDistillCandidateRecord,
} from './distill-candidate-registry.js';
import { getReasoningBackend } from './reasoning-backend.js';
import {
  buildScopedIndex,
  queryKnowledgeHybrid,
  type KnowledgeHint,
  type KnowledgeScope,
} from './src/knowledge-index.js';
import { parseStructuredJson } from './structured-reasoning.js';
import { z } from 'zod';
import {
  loadMemoryPromotionCandidate,
  listMemoryPromotionCandidates,
  type MemoryCandidate,
  updateMemoryPromotionCandidateStatus,
} from './memory-promotion-queue.js';
import {
  savePromotedMemoryRecord,
  NotMeaningfulPromotionCandidateError,
} from './promoted-memory.js';
import { logger } from './core.js';
import { assessMissionMemoryCandidate } from './mission-assessment.js';
import { listInboxEntries } from './deliverable-inbox.js';

type PromotedMemoryExecutionRole = 'mission_controller' | 'chronos_gateway';

const PromotionContradictionAssessmentSchema = z.object({
  verdict: z.enum(['yes', 'no', 'unrelated']),
  reason: z.string().min(1),
});

export interface PromotionKnowledgeMatch {
  topic: string;
  hint: string;
  source: string;
  confidence: number;
  tier?: KnowledgeHint['tier'];
  tags?: string[];
}

export interface PromotionContradictionAssessment {
  verdict: 'yes' | 'no' | 'unrelated';
  reason: string;
}

export interface PromotionReview {
  reviewed_at: string;
  backend: string;
  similar_knowledge: PromotionKnowledgeMatch[];
  contradiction?: PromotionContradictionAssessment;
}

export interface PersonalAutopromoteSummary {
  enabled: boolean;
  considered: number;
  promoted: string[];
  skipped: Array<{ candidate_id: string; reason: string }>;
}

function promotionKnowledgeScope(): KnowledgeScope {
  return { tiers: ['public', 'confidential', 'personal', 'product'] };
}

function mapKnowledgeMatch(hint: KnowledgeHint): PromotionKnowledgeMatch {
  return {
    topic: hint.topic,
    hint: hint.hint,
    source: hint.source,
    confidence: hint.confidence,
    tier: hint.tier,
    tags: hint.tags,
  };
}

function formatKnowledgeMatch(match: PromotionKnowledgeMatch, index: number): string {
  const tags = match.tags && match.tags.length > 0 ? ` tags=${match.tags.join(', ')}` : '';
  const tier = match.tier ? ` tier=${match.tier}` : '';
  return `${index + 1}. ${match.topic} (${match.source}) confidence=${match.confidence.toFixed(2)}${tier}${tags}`;
}

async function inspectPromotionReview(candidate: MemoryCandidate): Promise<PromotionReview> {
  const reviewedAt = new Date().toISOString();
  try {
    const index = await buildScopedIndex(promotionKnowledgeScope());
    const similar = await queryKnowledgeHybrid(index, candidate.summary, { maxResults: 3 });
    const similarKnowledge = similar.map(mapKnowledgeMatch);
    const backend = getReasoningBackend();
    let contradiction: PromotionContradictionAssessment | undefined;

    for (const [idx, match] of similarKnowledge.entries()) {
      logger.info(
        `[memory-promotion] similar knowledge ${idx + 1}/${similarKnowledge.length}: ${formatKnowledgeMatch(match, idx)}`
      );
    }

    if (backend.name !== 'stub' && similarKnowledge.length > 0) {
      const topMatch = similarKnowledge[0];
      const prompt = [
        'Assess whether the proposed memory candidate conflicts with the existing knowledge item.',
        'Return exactly one JSON object with keys: verdict, reason.',
        'verdict must be one of: yes, no, unrelated.',
        'Use yes only if the candidate and the knowledge item materially contradict.',
        'Use no if they are compatible or complementary.',
        'Use unrelated if they are not about the same factual claim.',
        '',
        `Candidate summary: ${candidate.summary}`,
        `Candidate source_ref: ${candidate.source_ref}`,
        '',
        'Existing knowledge item:',
        JSON.stringify(topMatch, null, 2),
      ].join('\n');
      try {
        const raw = await backend.prompt(prompt);
        const parsed = parseStructuredJson(raw, 'memory-promotion contradiction assessment');
        const validated = PromotionContradictionAssessmentSchema.safeParse(parsed);
        if (validated.success) {
          contradiction = validated.data;
          if (contradiction.verdict === 'yes') {
            logger.warn(
              `[memory-promotion] contradiction suspected for ${candidate.candidate_id}: ${contradiction.reason}`
            );
          } else {
            logger.info(
              `[memory-promotion] contradiction check for ${candidate.candidate_id}: ${contradiction.verdict} — ${contradiction.reason}`
            );
          }
        } else {
          logger.warn(
            `[memory-promotion] contradiction assessment returned invalid JSON for ${candidate.candidate_id}: ${validated.error.message}`
          );
        }
      } catch (err: any) {
        logger.warn(
          `[memory-promotion] contradiction assessment failed for ${candidate.candidate_id}: ${err?.message || err}`
        );
      }
    }

    return {
      reviewed_at: reviewedAt,
      backend: backend.name,
      similar_knowledge: similarKnowledge,
      ...(contradiction ? { contradiction } : {}),
    };
  } catch (err: any) {
    logger.warn(
      `[memory-promotion] knowledge review skipped for ${candidate.candidate_id}: ${err?.message || err}`
    );
    return defaultPromotionReview();
  }
}

function mapMemoryKindToDistillTarget(
  kind: MemoryCandidate['proposed_memory_kind']
): DistillCandidateRecord['target_kind'] {
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
  deliverableId?: string;
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
  if (trimmed.startsWith('deliverable:')) {
    const deliverableId = trimmed.replace(/^deliverable:/u, '').trim();
    return deliverableId ? { deliverableId } : {};
  }
  if (trimmed.startsWith('heuristic:')) {
    return {};
  }
  return {};
}

function assertDeliverablePromotionReady(candidate: MemoryCandidate): void {
  const source = parseSourceRef(candidate.source_ref);
  if (!source.deliverableId) return;
  const entry = listInboxEntries({ query: source.deliverableId, limit: 10 }).find(
    (item) => item.entry_id === source.deliverableId
  );
  if (!entry?.acceptance_receipt || !entry.delivery_receipt) {
    throw new Error(
      `Memory promotion candidate ${candidate.candidate_id} requires a human acceptance and delivery receipt for ${source.deliverableId}.`
    );
  }
  if (entry.acceptance_receipt.artifact_digest !== entry.delivery_receipt.artifact_digest) {
    throw new Error(
      `Memory promotion candidate ${candidate.candidate_id} references a deliverable with mismatched artifact receipts.`
    );
  }
}

function toDistillSourceType(
  sourceType: MemoryCandidate['source_type']
): DistillCandidateRecord['source_type'] {
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

function buildDistillCandidateFromMemoryCandidate(
  candidate: MemoryCandidate
): DistillCandidateRecord {
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

function defaultPromotionReview(): PromotionReview {
  return {
    reviewed_at: new Date().toISOString(),
    backend: getReasoningBackend().name,
    similar_knowledge: [],
  };
}

function resolveAutopromoteMode(): 'personal' | null {
  return String(process.env.KYBERION_MEMORY_AUTOPROMOTE || '')
    .trim()
    .toLowerCase() === 'personal'
    ? 'personal'
    : null;
}

function shouldConsiderPersonalAutopromote(candidate: MemoryCandidate): boolean {
  return (
    candidate.sensitivity_tier === 'personal' &&
    candidate.status !== 'promoted' &&
    candidate.status !== 'rejected'
  );
}

function assessPersonalAutopromoteEligibility(candidate: MemoryCandidate) {
  if (candidate.source_type !== 'mission') {
    return {
      eligible: false,
      reason: 'Personal autopromote only considers mission-sourced candidates.',
    };
  }
  const missionId = parseSourceRef(candidate.source_ref).missionId || '';
  return assessMissionMemoryCandidate({
    missionId,
    missionType: candidate.proposed_memory_kind,
    summary: candidate.summary,
    evidenceCount: candidate.evidence_refs.length,
    tier: candidate.sensitivity_tier,
  });
}

export async function promotePersonalMemoryCandidates(
  input: {
    executionRole?: PromotedMemoryExecutionRole;
    ratificationNote?: string;
    dryRun?: boolean;
  } = {}
): Promise<PersonalAutopromoteSummary> {
  if (resolveAutopromoteMode() !== 'personal') {
    return { enabled: false, considered: 0, promoted: [], skipped: [] };
  }

  const candidates = listMemoryPromotionCandidates().filter(shouldConsiderPersonalAutopromote);
  const promoted: string[] = [];
  const skipped: Array<{ candidate_id: string; reason: string }> = [];

  for (const candidate of candidates) {
    const eligibility = assessPersonalAutopromoteEligibility(candidate);
    if (!eligibility.eligible) {
      skipped.push({ candidate_id: candidate.candidate_id, reason: eligibility.reason });
      continue;
    }

    const review = await inspectPromotionReview(candidate);
    if (review.contradiction?.verdict === 'yes') {
      skipped.push({
        candidate_id: candidate.candidate_id,
        reason: `Contradiction warning: ${review.contradiction.reason}`,
      });
      continue;
    }

    if (input.dryRun) {
      promoted.push(candidate.candidate_id);
      continue;
    }

    const result = await promoteMemoryCandidateToKnowledge({
      candidateId: candidate.candidate_id,
      executionRole: input.executionRole || 'mission_controller',
      ratificationNote: input.ratificationNote || 'Autopromoted personal memory candidate.',
    });
    promoted.push(result.candidate.candidate_id);
  }

  return {
    enabled: true,
    considered: candidates.length,
    promoted,
    skipped,
  };
}

export async function promoteMemoryCandidateToKnowledge(input: {
  candidateId: string;
  executionRole?: PromotedMemoryExecutionRole;
  ratificationNote?: string;
  supersedes?: string;
}): Promise<{ candidate: MemoryCandidate; promotedRef: string; review: PromotionReview }> {
  const candidateId = String(input.candidateId || '').trim();
  if (!candidateId) throw new Error('candidateId is required.');
  const candidate = loadMemoryPromotionCandidate(candidateId);
  if (!candidate) throw new Error(`Memory promotion candidate not found: ${candidateId}`);
  if (candidate.status === 'rejected') {
    throw new Error(
      `Memory promotion candidate ${candidateId} is rejected and cannot be promoted.`
    );
  }
  if (candidate.status === 'promoted') {
    const storedReview = loadDistillCandidateRecord(candidateId)?.metadata?.promotion_review;
    return {
      candidate,
      promotedRef: candidate.promoted_ref || '',
      review:
        storedReview && typeof storedReview === 'object'
          ? (storedReview as PromotionReview)
          : defaultPromotionReview(),
    };
  }
  if (candidate.ratification_required && candidate.status !== 'approved') {
    throw new Error(
      `Memory promotion candidate ${candidateId} requires ratification before promotion.`
    );
  }
  if ((candidate.evidence_refs || []).length === 0) {
    throw new Error(
      `Memory promotion candidate ${candidateId} requires evidence_refs for promotion.`
    );
  }
  assertDeliverablePromotionReady(candidate);

  const review = await inspectPromotionReview(candidate);
  const baseDistillCandidate = buildDistillCandidateFromMemoryCandidate(candidate);
  const distillCandidate = {
    ...baseDistillCandidate,
    metadata: {
      ...baseDistillCandidate.metadata,
      ...(typeof input.supersedes === 'string' && input.supersedes.trim()
        ? { supersedes: input.supersedes.trim() }
        : {}),
      promotion_review: review,
    },
  };
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
        `[memory-promotion] Skipped promotion of ${distillCandidate.candidate_id}: ${err.reason}`
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
      return { candidate: rejected, promotedRef: '', review };
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
    review,
  };
}
