import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * IT-02 / S7: the turn's reply locale is scoped to the turn (AsyncLocalStorage
 * run(), not enterWith()) and is already in effect when the HA-01 background
 * review fork is triggered.
 */
const mocks = vi.hoisted(() => ({
  recordExecutionFeedback: vi.fn(),
  parseExecutionFeedbackText: vi.fn(),
  triggerBackgroundReviewFork: vi.fn(),
  localeSeenByFork: [] as Array<string | undefined>,
}));

vi.mock('../execution-feedback.js', () => ({
  recordExecutionFeedback: mocks.recordExecutionFeedback,
  parseExecutionFeedbackText: mocks.parseExecutionFeedbackText,
}));

vi.mock('../workforce/background-review-runner.js', () => ({
  triggerBackgroundReviewFork: mocks.triggerBackgroundReviewFork,
}));

const FEEDBACK = {
  scenario_id: 'use-case-schedule-read-agenda',
  intent_id: 'schedule-read-agenda',
  outcome: 'satisfied' as const,
};

describe('surface runtime orchestrator — turn-scoped reply locale', () => {
  const originalLocale = process.env.KYBERION_LOCALE;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.localeSeenByFork.length = 0;
    // The operator locale is Japanese; replies must still follow the user.
    process.env.KYBERION_LOCALE = 'ja';
    mocks.parseExecutionFeedbackText.mockReturnValue(null);
    mocks.recordExecutionFeedback.mockImplementation((input: typeof FEEDBACK) => ({
      ...input,
      feedback_id: 'FB-1',
      recorded_at: '2026-10-01T00:00:00.000Z',
    }));
    const { getReplyLocale } = await import('../locale.js');
    mocks.triggerBackgroundReviewFork.mockImplementation(() => {
      mocks.localeSeenByFork.push(getReplyLocale());
      return { review_due: false };
    });
  });

  afterEach(() => {
    if (originalLocale === undefined) delete process.env.KYBERION_LOCALE;
    else process.env.KYBERION_LOCALE = originalLocale;
  });

  it('answers in the user language without leaking the locale into the caller', async () => {
    const { runSurfaceConversation } = await import('./surface-runtime-orchestrator.js');
    const { getReplyLocale } = await import('../locale.js');
    expect(getReplyLocale()).toBeUndefined();

    const result = await runSurfaceConversation({
      agentId: 'presence-surface-agent',
      query: 'please record my feedback',
      senderAgentId: 'test-sender',
      executionFeedback: FEEDBACK,
    });

    expect(result.text).not.toMatch(/[぀-ヿ]/);
    expect(getReplyLocale()).toBeUndefined();
  });

  it('enters the reply locale before the HA-01 fork and ends it with the turn', async () => {
    mocks.parseExecutionFeedbackText.mockReturnValue(FEEDBACK);
    const { runSurfaceMessageConversation } = await import('./surface-runtime-orchestrator.js');
    const { getReplyLocale } = await import('../locale.js');

    const result = await runSurfaceMessageConversation({
      surface: 'slack',
      text: 'feedback use-case-schedule-read-agenda: satisfied',
      channel: 'C1',
      threadTs: 'T1',
      senderAgentId: 'test-sender',
      agentId: 'slack-surface-agent',
    });

    expect(mocks.triggerBackgroundReviewFork).toHaveBeenCalledTimes(1);
    expect(mocks.localeSeenByFork).toEqual(['en']);
    expect(result.text).not.toMatch(/[぀-ヿ]/);
    expect(getReplyLocale()).toBeUndefined();
  });
});
