import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SurfaceUxContractResult } from './surface-ux-contract.js';

/**
 * M5 regression: `approval_required` is the only UX-contract rule that is
 * derived from the turn (intent authority level / approval requests / mission
 * proposals) rather than from the text alone, and nothing exercised it through
 * the production conversation path. These tests drive
 * `runSurfaceMessageConversation` — the chokepoint every surface bridge calls —
 * with an agent reply that carries an ```approval``` block, and assert the
 * approval rule (consequence + unblock action) is actually reported on
 * `result.uxContract`.
 */

const mocks = vi.hoisted(() => ({
  ask: vi.fn<(prompt: string, options?: unknown) => Promise<string>>(),
  compileUserIntentFlow: vi.fn(),
  resolveSurfaceIntent: vi.fn(),
  parseExecutionFeedbackText: vi.fn(),
  triggerBackgroundReviewFork: vi.fn(),
}));

vi.mock('./agent-runtime-supervisor.js', () => ({
  ensureAgentRuntime: vi.fn(),
  getAgentRuntimeHandle: () => ({
    ask: mocks.ask,
    getRecord: () => ({ status: 'ready' }),
  }),
}));

// Mirrors the sibling orchestrator suites: intent-contract is stubbed rather
// than imported for real so the conversation under test stays deterministic
// (no catalog compilation, no clarification packet) and the reply text is the
// only thing the UX contract can react to.
vi.mock('./intent-contract.js', () => ({
  compileUserIntentFlow: mocks.compileUserIntentFlow,
  formatClarificationPacketConcise: () => 'clarification',
  isSimpleGreetingText: () => false,
}));

vi.mock('./router-contract.js', () => ({
  resolveSurfaceIntent: mocks.resolveSurfaceIntent,
  resolveDirectIntentCommand: () => null,
}));

vi.mock('./surface-runtime-router.js', async () => {
  const actual = await vi.importActual<typeof import('./surface-runtime-router.js')>(
    './surface-runtime-router.js'
  );
  return {
    ...actual,
    deriveSurfaceDelegationReceiver: () => undefined,
    normalizeSurfaceDelegationReceiver: () => undefined,
    resolveSurfaceConversationReceiver: () => undefined,
    shouldCompileSurfaceIntent: () => false,
  };
});

vi.mock('./execution-feedback.js', async () => {
  const actual =
    await vi.importActual<typeof import('./execution-feedback.js')>('./execution-feedback.js');
  return {
    ...actual,
    parseExecutionFeedbackText: mocks.parseExecutionFeedbackText,
  };
});

vi.mock('./background-review-runner.js', () => ({
  triggerBackgroundReviewFork: mocks.triggerBackgroundReviewFork,
}));

const APPROVAL_BLOCK = [
  '```approval',
  JSON.stringify({
    title: '本番デプロイの承認',
    summary: '本番環境へのデプロイを実行します。',
    mission_id: 'MIS-APPROVAL-TEST',
  }),
  '```',
].join('\n');

/** Carries user-facing signals, but says nothing about waiting or unblocking. */
const REPLY_WITHOUT_APPROVAL_FRAMING = [
  '依頼内容を理解しました。実行計画は本番デプロイの準備です。',
  '結果は完了後に共有します。',
  APPROVAL_BLOCK,
].join('\n\n');

/** Same reply plus the consequence of waiting and the concrete unblock action. */
const REPLY_WITH_APPROVAL_FRAMING = [
  '依頼内容を理解しました。実行計画は本番デプロイの準備です。',
  '承認がない場合は待機したままで実行されません。',
  '次のアクション: この計画を承認してください。',
  APPROVAL_BLOCK,
].join('\n\n');

async function runTurn(replyText: string) {
  const { runSurfaceMessageConversation } = await import('./surface-runtime-orchestrator.js');
  const result = await runSurfaceMessageConversation({
    surface: 'telegram',
    text: '本番環境にデプロイして',
    channel: 'ops',
    threadTs: '1',
    actorId: 'operator-1',
    senderAgentId: 'test-sender',
  });
  return result as typeof result & { uxContract?: SurfaceUxContractResult };
}

describe('runSurfaceMessageConversation approval_required UX contract', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.compileUserIntentFlow.mockResolvedValue(null);
    mocks.resolveSurfaceIntent.mockReturnValue({});
    mocks.parseExecutionFeedbackText.mockReturnValue(null);
    mocks.triggerBackgroundReviewFork.mockReturnValue({ review_due: false });
  });

  it('reports the approval consequence + unblock violations when the reply omits them', async () => {
    // Every ask (including the escalation re-ask) returns the same
    // non-compliant draft, so the turn lands on the chokepoint verdict.
    mocks.ask.mockResolvedValue(REPLY_WITHOUT_APPROVAL_FRAMING);

    const result = await runTurn(REPLY_WITHOUT_APPROVAL_FRAMING);

    // The approval branch is reached through the real derivation: the agent
    // reply carried an approval request block.
    expect(result.approvalRequests?.length ?? 0).toBeGreaterThan(0);
    expect(result.uxContract).toBeDefined();
    expect(result.uxContract?.valid).toBe(false);
    expect(result.uxContract?.violations).toEqual(
      expect.arrayContaining([
        'Approval-required response must explain consequence of waiting/rejection.',
        'Approval-required response must include a concrete unblock action.',
      ])
    );
  });

  it('reports no violations when the reply carries the consequence and unblock action', async () => {
    mocks.ask.mockResolvedValue(REPLY_WITH_APPROVAL_FRAMING);

    const result = await runTurn(REPLY_WITH_APPROVAL_FRAMING);

    expect(result.approvalRequests?.length ?? 0).toBeGreaterThan(0);
    expect(result.uxContract).toBeDefined();
    expect(result.uxContract?.violations).toEqual([]);
    expect(result.uxContract?.valid).toBe(true);
  });

  it('escalates the approval-incomplete draft before delivery instead of shipping it as-is', async () => {
    // The in-conversation escalation call site must see approval_required too:
    // a draft that only fails the approval rule has to trigger the standard-tier
    // re-ask, and the compliant re-ask result is what gets delivered.
    mocks.ask
      .mockResolvedValueOnce(REPLY_WITHOUT_APPROVAL_FRAMING)
      .mockResolvedValue(REPLY_WITH_APPROVAL_FRAMING);

    const result = await runTurn(REPLY_WITHOUT_APPROVAL_FRAMING);

    expect(mocks.ask.mock.calls.length).toBeGreaterThan(1);
    expect(mocks.ask.mock.calls[1]?.[1]).toMatchObject({ model_tier: 'standard' });
    expect(result.text).toContain('承認がない場合');
    expect(result.uxContract?.valid).toBe(true);
  });
});
