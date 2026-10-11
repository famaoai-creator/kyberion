import { describe, expect, it } from 'vitest';
import { buildReviewCloseOutStep } from './mission-review-close-out.js';

describe('buildReviewCloseOutStep', () => {
  const review = { missionId: 'MSN-1', reviewTaskId: 'impl-review', reviewerAgentId: 'r' };
  const missionPath = '/repo/active/missions/public/MSN-1';
  it('names the missing REVIEW deliverable and the record-evidence close-out', () => {
    expect(buildReviewCloseOutStep(review, {}, missionPath)).toMatch(
      /<REVIEW deliverable>.*missing.*record-evidence MSN-1 impl-review/s
    );
  });
  it('marks an outside-scope deliverable as missing without touching the filesystem', () => {
    expect(buildReviewCloseOutStep(review, { deliverable: '../../x.md' }, missionPath)).toContain(
      '(missing)'
    );
  });
});
