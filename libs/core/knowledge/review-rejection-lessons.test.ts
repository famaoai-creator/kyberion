import { describe, expect, it } from 'vitest';
import type { KnowledgeHint } from './knowledge-index.js';
import { selectReviewRejectionLessons } from './review-rejection-lessons.js';

const target = { mission_id: 'MSN-A', organization_id: 'org-a', project_id: 'project-a' };
const legacy: KnowledgeHint = {
  topic: 'human-rejection:scope',
  hint: 'legacy artifact and comment',
  source: 'review-reentry:legacy',
  confidence: 0.8,
};

describe('review rejection lessons', () => {
  it('prioritizes the mission and project, and shares only guidance from another project', () => {
    const hints: KnowledgeHint[] = [
      {
        ...legacy,
        topic: 'human-rejection:quality:1',
        review_rejection: { ...target, detail: 'Same mission detail' },
      },
      {
        ...legacy,
        topic: 'human-rejection:quality:2',
        review_rejection: { ...target, mission_id: 'MSN-B', detail: 'Same project detail' },
      },
      {
        ...legacy,
        topic: 'human-rejection:incorrect_content:3',
        review_rejection: {
          ...target,
          mission_id: 'MSN-C',
          project_id: 'project-b',
          detail: 'Other project artifact and comment',
        },
      },
    ];
    expect(selectReviewRejectionLessons(hints, target)).toEqual([
      'Same mission detail',
      'Same project detail',
      'Verify factual claims against the source material before submission.',
    ]);
  });

  it('generalizes legacy rows and project IDs reused in a different organization', () => {
    expect(
      selectReviewRejectionLessons(
        [
          legacy,
          {
            ...legacy,
            topic: 'human-rejection:quality:1',
            review_rejection: { ...target, organization_id: 'org-b', detail: 'Other org detail' },
          },
        ],
        target
      )
    ).toEqual([
      'Check the deliverable against the acceptance criteria before submission.',
      'Check that the deliverable covers the requested scope and avoids unrelated work.',
    ]);
  });
});
