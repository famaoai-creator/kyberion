import * as path from 'node:path';
import { assertSafeRepositoryPath, safeExistsSync } from '../secure-io.js';

/**
 * Close-out guidance for a review-kind task. Recording a review never closes
 * the review task by itself: the REVIEW deliverable must exist and be adopted
 * via record-evidence. Callers surface the returned step whenever the review
 * task is still open after recording, instead of letting `finish` complain.
 */
export function buildReviewCloseOutStep(
  review: { missionId: string; reviewTaskId: string; reviewerAgentId: string },
  task: { deliverable?: unknown },
  missionPath: string
): string {
  const missionId = review.missionId.toUpperCase();
  const deliverable = typeof task.deliverable === 'string' ? task.deliverable : '';
  let missing = !deliverable;
  if (!missing) {
    const candidate = path.resolve(missionPath, deliverable);
    const rel = path.relative(missionPath, candidate);
    const outside = rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`);
    missing =
      outside || !safeExistsSync(assertSafeRepositoryPath(candidate, { allowMissingLeaf: true }));
  }
  return (
    `Write ${deliverable || '<REVIEW deliverable>'} with the review verdict` +
    (missing ? ' (missing)' : '') +
    `, then close the task: pnpm mission record-evidence ${missionId} ${review.reviewTaskId} "<note>" --actor-id ${review.reviewerAgentId}.`
  );
}
