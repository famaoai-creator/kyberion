import { randomUUID } from 'node:crypto';
import { nowIso } from '../foundation/time.js';
import {
  listGovernedArtifacts,
  readGovernedArtifactJson,
  writeGovernedArtifactJson,
  type GovernedArtifactRole,
} from './artifact-store.js';
import { logger } from '../core.js';
import { persistHints } from '../knowledge/feedback-loop.js';
import { queueMissionMemoryPromotionCandidate } from '../knowledge/memory-promotion-queue.js';
import { missionMemoryCaptureScope } from '../knowledge/memory-capture-scope.js';
import { reviewRejectionGuidance } from '../knowledge/review-rejection-lessons.js';
import type { RejectionReasonCategory } from '../contracts/rejection-reason.js';

/**
 * LC-11 (LOOP_CLOSURE_PLAN): the reject → amended re-execution channel.
 *
 * A human review verdict (reject / request-changes) on a deliverable is
 * enqueued here by the reviewing surface. The mission lifecycle consumes
 * pending requests: at finish time they merge into the goal-satisfaction
 * reconciliation as gaps (so the existing IL-04 goal loop turns them into
 * implementer+reviewer rework tasks), and for already-completed missions the
 * `review-reenter` controller command re-opens the mission the same way.
 * No new state machine — human rejections ride the machine IL-04 built.
 */

export type ReviewReentryVerdict = 'reject' | 'request-changes';

export type ReviewChangeLevel =
  'L1_goal_purpose' | 'L2_requirement_process' | 'L3_implementation_model';

/**
 * Map a closed human rejection category onto IPA's 3-level change hierarchy
 * so opt-in routing can separate goal re-alignment (L1) and requirement/scope
 * updates (L2) from bounded implementation rework (L3).
 */
export function classifyReviewReentryChangeLevel(
  category?: RejectionReasonCategory
): ReviewChangeLevel {
  switch (category) {
    case 'wrong_direction':
      return 'L1_goal_purpose';
    case 'scope':
      return 'L2_requirement_process';
    case 'incorrect_content':
    case 'quality':
    case 'other':
    default:
      return 'L3_implementation_model';
  }
}

export interface ReviewReentryRequest {
  request_id: string;
  mission_id: string;
  artifact_id: string;
  artifact_path?: string;
  verdict: ReviewReentryVerdict;
  comment?: string;
  reason_category?: RejectionReasonCategory;
  reviewer: string;
  requested_at: string;
  status: 'pending' | 'processed';
  processed_at?: string;
  gap_task_ids?: string[];
}

const REENTRY_DIR = 'active/shared/coordination/review-reentry';

function reentryDir(missionId: string): string {
  return `${REENTRY_DIR}/${normalizeMissionId(missionId)}`;
}

function reentryPath(missionId: string, requestId: string): string {
  if (!/^[a-zA-Z0-9-]+$/.test(requestId)) {
    throw new Error(`Invalid review re-entry request id: ${requestId}`);
  }
  return `${reentryDir(missionId)}/${requestId}.json`;
}

function normalizeMissionId(missionId: string): string {
  const normalized = String(missionId || '')
    .trim()
    .toUpperCase();
  if (!/^[A-Z0-9_-]+$/.test(normalized)) {
    throw new Error(`Invalid mission id for review re-entry: ${missionId}`);
  }
  return normalized;
}

export function enqueueReviewReentryRequest(
  role: GovernedArtifactRole,
  input: {
    missionId: string;
    artifactId: string;
    artifactPath?: string;
    verdict: ReviewReentryVerdict;
    comment?: string;
    reasonCategory?: RejectionReasonCategory;
    reviewer: string;
  }
): ReviewReentryRequest {
  const record: ReviewReentryRequest = {
    request_id: randomUUID(),
    mission_id: normalizeMissionId(input.missionId),
    artifact_id: input.artifactId,
    artifact_path: input.artifactPath,
    verdict: input.verdict,
    comment: input.comment?.trim() || undefined,
    reason_category: input.reasonCategory,
    reviewer: input.reviewer,
    requested_at: nowIso(),
    status: 'pending',
  };
  writeGovernedArtifactJson(role, reentryPath(record.mission_id, record.request_id), record);
  persistRejectionLearning(record);
  return record;
}

/**
 * LC-12: a human rejection is a lesson, not just a redo trigger. Persist it as
 * a runtime KnowledgeHint (auto-ingested into the knowledge index, so future
 * same-shape work retrieves it) and nominate it into the KM-03 promotion
 * queue (governed ratification — never a direct HINTS.md write). Best-effort:
 * learning must not block the re-entry channel.
 */
function persistRejectionLearning(record: ReviewReentryRequest): void {
  const category = record.reason_category || 'uncategorized';
  const summary = [
    `Human review ${record.verdict} on deliverable ${record.artifact_id} (mission ${record.mission_id})`,
    `[${category}]`,
    record.comment ? `reviewer: ${record.comment}` : undefined,
  ]
    .filter(Boolean)
    .join(' ');
  let capture: ReturnType<typeof missionMemoryCaptureScope>;
  try {
    capture = missionMemoryCaptureScope(record.mission_id);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn(`[review-reentry] failed to resolve rejection learning scope: ${detail}`);
    return;
  }
  try {
    persistHints(
      [
        {
          topic: `human-rejection:${record.reason_category || 'other'}:${record.request_id}`,
          hint: reviewRejectionGuidance(record.reason_category),
          source: `review-reentry:${record.request_id}`,
          confidence: 0.8,
          tags: ['human_rejection', record.verdict, category],
          review_rejection: {
            mission_id: record.mission_id,
            organization_id: capture.scope?.organization_id,
            project_id: capture.scope?.project_id,
            detail: summary,
          },
        },
      ],
      'human-rejection',
      capture.scope ?? { tier: capture.tier }
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn(`[review-reentry] failed to persist rejection hint: ${detail}`);
  }
  try {
    // D8: the lesson carries the rejected mission's own tier and tenant scope.
    queueMissionMemoryPromotionCandidate({
      missionId: record.mission_id,
      tier: capture.tier,
      summary,
      evidenceRefs: [`review-reentry:${record.request_id}`],
      ...(capture.scope ? { scope: capture.scope } : {}),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn(`[review-reentry] failed to queue rejection memory candidate: ${detail}`);
  }
}

export function listReviewReentryRequests(missionId: string): ReviewReentryRequest[] {
  const dir = reentryDir(missionId);
  return listGovernedArtifacts(dir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => readGovernedArtifactJson<ReviewReentryRequest>(`${dir}/${entry}`))
    .filter((record): record is ReviewReentryRequest => Boolean(record))
    .sort((left, right) => left.requested_at.localeCompare(right.requested_at));
}

export function listPendingReviewReentryRequests(missionId: string): ReviewReentryRequest[] {
  return listReviewReentryRequests(missionId).filter((record) => record.status === 'pending');
}

export function markReviewReentryProcessed(
  role: GovernedArtifactRole,
  missionId: string,
  requestId: string,
  gapTaskIds: string[]
): ReviewReentryRequest | null {
  const logicalPath = reentryPath(missionId, requestId);
  const record = readGovernedArtifactJson<ReviewReentryRequest>(logicalPath);
  if (!record) return null;
  const updated: ReviewReentryRequest = {
    ...record,
    status: 'processed',
    processed_at: nowIso(),
    gap_task_ids: gapTaskIds,
  };
  writeGovernedArtifactJson(role, logicalPath, updated);
  return updated;
}

const REASON_CATEGORY_GAP_HINT: Record<RejectionReasonCategory, string> = {
  incorrect_content: 'the content is factually wrong — verify against the sources and correct it',
  wrong_direction: 'the approach misses what was actually asked — re-read the goal before redoing',
  quality: 'the quality is below the bar — refine structure, depth, and polish',
  scope: 'the scope is off (too much or too little) — match the deliverable to the request',
  other: 'see the reviewer comment for what to change',
};

/**
 * Render a re-entry request as a goal gap the IL-04 loop can act on. The text
 * is the task brief seed, so it carries verdict, category guidance, and the
 * reviewer's own words.
 */
export function buildReviewGapText(request: ReviewReentryRequest): string {
  const parts = [
    `human review ${request.verdict} on deliverable ${request.artifact_id}`,
    request.reason_category
      ? `[${request.reason_category}] ${REASON_CATEGORY_GAP_HINT[request.reason_category]}`
      : undefined,
    request.comment ? `reviewer says: ${request.comment}` : undefined,
  ].filter(Boolean);
  return parts.join(' — ');
}
