import { afterEach, describe, expect, it } from 'vitest';
import { withExecutionContext } from './authority.js';
import { safeRmSync } from './secure-io.js';
import {
  backgroundReviewNudgeStatePath,
  completeBackgroundReview,
  loadBackgroundReviewNudgeState,
  recordBackgroundReviewActivity,
} from './background-review-nudge.js';

const SESSION_ID = `nudge-test-${process.pid}-${Date.now()}`;

afterEach(() => {
  withExecutionContext('mission_controller', () => {
    safeRmSync(backgroundReviewNudgeStatePath(SESSION_ID), { force: true });
  });
});

describe('background-review-nudge', () => {
  it('reserves one review at the turn threshold and preserves the remainder', () => {
    const first = withExecutionContext('mission_controller', () =>
      recordBackgroundReviewActivity({
        sessionId: SESSION_ID,
        activity: 'turn',
        config: { turnThreshold: 3, toolThreshold: 10 },
      })
    );
    expect(first.review_due).toBe(false);
    withExecutionContext('mission_controller', () =>
      recordBackgroundReviewActivity({
        sessionId: SESSION_ID,
        activity: 'turn',
        config: { turnThreshold: 3, toolThreshold: 10 },
      })
    );
    const due = withExecutionContext('mission_controller', () =>
      recordBackgroundReviewActivity({
        sessionId: SESSION_ID,
        activity: 'turn',
        config: { turnThreshold: 3, toolThreshold: 10 },
      })
    );
    expect(due.review_due).toBe(true);
    expect(due.state).toMatchObject({ turns_since_review: 0, review_pending: true });

    const whilePending = withExecutionContext('mission_controller', () =>
      recordBackgroundReviewActivity({
        sessionId: SESSION_ID,
        activity: 'turn',
        config: { turnThreshold: 3, toolThreshold: 10 },
      })
    );
    expect(whilePending.review_due).toBe(false);
    expect(whilePending.state.turns_since_review).toBe(1);

    const completed = withExecutionContext('mission_controller', () =>
      completeBackgroundReview(SESSION_ID)
    );
    expect(completed.review_pending).toBe(false);
    expect(loadBackgroundReviewNudgeState(SESSION_ID)).toMatchObject({ turns_since_review: 1 });
  });

  it('triggers on tool calls and resets on skill/knowledge activity', () => {
    const due = withExecutionContext('mission_controller', () =>
      recordBackgroundReviewActivity({
        sessionId: SESSION_ID,
        activity: 'tool',
        config: { turnThreshold: 10, toolThreshold: 2 },
      })
    );
    expect(due.review_due).toBe(false);
    const second = withExecutionContext('mission_controller', () =>
      recordBackgroundReviewActivity({
        sessionId: SESSION_ID,
        activity: 'tool',
        config: { turnThreshold: 10, toolThreshold: 2 },
      })
    );
    expect(second.review_due).toBe(true);

    const reset = withExecutionContext('mission_controller', () =>
      recordBackgroundReviewActivity({
        sessionId: SESSION_ID,
        activity: 'tool',
        operation: 'knowledge:read',
        config: { turnThreshold: 10, toolThreshold: 2 },
      })
    );
    expect(reset).toMatchObject({ review_due: false, reset: true });
    expect(reset.state).toMatchObject({
      turns_since_review: 0,
      tool_calls_since_review: 0,
      review_pending: false,
    });
  });

  it('rejects path-unsafe session ids', () => {
    expect(() => loadBackgroundReviewNudgeState('../escape')).toThrow('[POLICY_VIOLATION]');
  });
});
