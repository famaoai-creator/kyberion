import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionFeedbackInput } from '../execution-feedback.js';
import type { SurfaceConversationMessageInput } from './channel-surface-types.js';

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  background: vi.fn(),
  route: vi.fn(),
}));
vi.mock('../execution-feedback.js', async (original) => ({
  ...(await original<object>()),
  recordExecutionFeedback: mocks.record,
}));
vi.mock('../workforce/background-review-runner.js', () => ({
  triggerBackgroundReviewFork: mocks.background,
}));
vi.mock('../mesh/a2a-bridge.js', () => ({ a2aBridge: { route: mocks.route } }));
vi.mock('./surface-conversation-signals.js', () => ({
  recordFeedbackSignal: vi.fn(),
  recordClarificationSignal: vi.fn(),
}));
import {
  runSurfaceConversation,
  runSurfaceMessageConversation,
} from './surface-runtime-orchestrator.js';

const scope = {
  tier: 'confidential' as const,
  tenant_slug: 'synthetic-surface-feedback',
  organization_id: 'org-a',
  project_id: 'project-a',
  mission_id: 'MSN-SYNTHETIC-FEEDBACK',
  task_id: 'task-a',
};
const feedback: ExecutionFeedbackInput = {
  scenario_id: 'use-case-synthetic',
  intent_id: 'synthetic',
  outcome: 'dissatisfied',
  correction: 'Check the original brief.',
};
const input = (): SurfaceConversationMessageInput => ({
  surface: 'cli',
  agentId: 'cli-surface-agent',
  senderAgentId: 'kyberion:home-cli',
  channel: 'kyberion-home',
  text: 'feedback use-case-synthetic: dissatisfied: Check the original brief.',
  correlationId: 'current-turn',
  scope: { ...scope, scope_kind: 'task' },
  executionFeedback: feedback,
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.record.mockImplementation((value: ExecutionFeedbackInput) => ({
    ...value,
    kind: 'execution-feedback',
    schema_version: '1.0.0',
    feedback_id: 'synthetic-feedback',
    recorded_at: '2026-10-20T00:00:00.000Z',
    source: 'user',
  }));
  mocks.background.mockReturnValue({ review_due: false });
});

describe('scoped local feedback admission', () => {
  it('converts EventScope to the exact memory scope without leaking into background review or A2A', async () => {
    const result = await runSurfaceMessageConversation(input());
    expect(mocks.record).toHaveBeenCalledWith({
      ...feedback,
      scope,
      correlation_id: 'current-turn',
      surface: 'cli',
    });
    expect(result.executionFeedbackRecord?.scope).toEqual(scope);
    expect(result.executionFeedbackRecord?.scope).not.toHaveProperty('scope_kind');
    expect(mocks.background).not.toHaveBeenCalled();
    expect(mocks.route).not.toHaveBeenCalled();
  });

  it.each([
    {
      locale: 'en' as const,
      recorded: 'Feedback recorded',
      review: 'Human review',
      unchanged: 'not changed automatically',
    },
    {
      locale: 'ja' as const,
      recorded: '評価を記録しました',
      review: '本人レビュー',
      unchanged: '自動変更していません',
    },
  ])(
    'acknowledges scoped feedback as review-only without promising next-run reuse: $locale',
    async ({ locale, recorded, review, unchanged }) => {
      const result = await runSurfaceMessageConversation({ ...input(), locale });
      expect(result.text).toContain(recorded);
      expect(result.text).toContain(review);
      expect(result.text).toContain(unchanged);
      expect(result.text).not.toMatch(/next time|次回/);
    }
  );

  it('preserves the original execution correlation when feedback arrives on a new turn', async () => {
    await runSurfaceMessageConversation({
      ...input(),
      executionFeedback: { ...feedback, correlation_id: 'original-execution', scope },
    });
    expect(mocks.record.mock.calls[0][0].correlation_id).toBe('original-execution');
  });

  it.each([
    { tenant_slug: 'another-tenant' },
    { organization_id: 'another-org' },
    { project_id: 'another-project' },
    { mission_id: 'MSN-ANOTHER' },
    { task_id: 'another-task' },
    { tier: 'public' },
    { allowed_audience: ['user:someone-else'] },
    { future_restriction: 'must-not-disappear' },
  ])('rejects conflicting feedback classification before any side effect: %j', async (override) => {
    await expect(
      runSurfaceMessageConversation({
        ...input(),
        executionFeedback: { ...feedback, scope: { ...scope, ...override } as never },
      })
    ).rejects.toThrow(/FEEDBACK_SCOPE/);
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.background).not.toHaveBeenCalled();
    expect(mocks.route).not.toHaveBeenCalled();
  });

  it('does not let an unscoped turn use a payload to choose a tenant', async () => {
    await expect(
      runSurfaceConversation({
        agentId: 'cli-surface-agent',
        senderAgentId: 'kyberion:home-cli',
        surface: 'cli',
        query: 'feedback',
        executionFeedback: { ...feedback, scope },
      })
    ).rejects.toThrow(/FEEDBACK_SCOPE_MISMATCH/);
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('rejects an unscoped structured payload before the message background-review fork', async () => {
    await expect(
      runSurfaceMessageConversation({
        ...input(),
        scope: undefined,
        executionFeedback: { ...feedback, scope },
      })
    ).rejects.toThrow(/FEEDBACK_SCOPE_MISMATCH/);
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.background).not.toHaveBeenCalled();
  });

  it('rejects malformed transport scope without dropping unknown fields', async () => {
    await expect(
      runSurfaceMessageConversation({
        ...input(),
        scope: { ...scope, future_restriction: 'must-not-disappear' } as never,
      })
    ).rejects.toThrow(/EVENT_SCOPE_INPUT_INVALID/);
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.background).not.toHaveBeenCalled();
  });

  it('refuses non-feedback scoped CLI requests before background review or delegation', async () => {
    await expect(
      runSurfaceMessageConversation({
        ...input(),
        text: 'Implement the next mission task.',
        executionFeedback: undefined,
      })
    ).rejects.toThrow(/SURFACE_CLI_SCOPE_UNSUPPORTED/);
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.background).not.toHaveBeenCalled();
    expect(mocks.route).not.toHaveBeenCalled();
  });
});
