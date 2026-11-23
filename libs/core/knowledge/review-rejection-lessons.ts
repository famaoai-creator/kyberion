import {
  normalizeRejectionReasonCategory,
  type RejectionReasonCategory,
} from '../contracts/rejection-reason.js';
import type { KnowledgeHint } from './knowledge-index.js';

const guidance: Record<RejectionReasonCategory, string> = {
  incorrect_content: 'Verify factual claims against the source material before submission.',
  wrong_direction: 'Check that the approach directly addresses the requested goal.',
  quality: 'Check the deliverable against the acceptance criteria before submission.',
  scope: 'Check that the deliverable covers the requested scope and avoids unrelated work.',
  other: 'Review the acceptance criteria and clarify any ambiguous expectations.',
};

export function reviewRejectionGuidance(category?: RejectionReasonCategory): string {
  return guidance[category ?? 'other'];
}

/** Project-independent guidance for both current and legacy review hint topics. */
export function sharedReviewRejectionGuidance(topic: string): string | undefined {
  const [kind, reason] = topic.split(':');
  if (kind !== 'human-rejection') return undefined;
  const category = reason === 'uncategorized' ? 'other' : normalizeRejectionReasonCategory(reason);
  return category ? reviewRejectionGuidance(category) : undefined;
}

/** Select within the already authorized hint partition, using origin only for relevance. */
export function selectReviewRejectionLessons(
  hints: readonly KnowledgeHint[],
  target: { mission_id: string; organization_id?: string; project_id?: string }
): string[] {
  const mission: string[] = [];
  const project: string[] = [];
  const shared = new Set<string>();
  for (const hint of [...hints].reverse()) {
    const lesson = sharedReviewRejectionGuidance(hint.topic);
    if (!lesson) continue;
    const origin = hint.review_rejection;
    const sameContext =
      origin?.project_id === target.project_id &&
      origin?.organization_id === target.organization_id;
    if (origin && sameContext && origin.mission_id === target.mission_id) {
      mission.push(origin.detail);
    } else if (origin?.project_id && sameContext) {
      project.push(origin.detail);
    } else {
      shared.add(lesson);
    }
  }
  return [...new Set([...mission, ...project, ...shared])].slice(0, 3);
}
