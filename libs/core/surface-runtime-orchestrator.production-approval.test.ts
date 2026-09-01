import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ask: vi.fn<(prompt: string, options?: unknown) => Promise<string>>(),
  triggerBackgroundReviewFork: vi.fn(),
}));

// Keep the provider boundary deterministic while importing the real
// intent-contract, intent-resolution, router-contract, and surface router
// modules. This suite is specifically for the production wiring between
// those modules and the surface conversation chokepoint.
vi.mock('./agent-runtime-supervisor.js', () => ({
  ensureAgentRuntime: vi.fn(),
  getAgentRuntimeHandle: () => ({
    ask: mocks.ask,
    getRecord: () => ({ status: 'ready' }),
  }),
}));

vi.mock('./background-review-runner.js', () => ({
  triggerBackgroundReviewFork: mocks.triggerBackgroundReviewFork,
}));

const APPROVAL_BLOCK = [
  '```approval',
  JSON.stringify({
    title: '連携シークレットの更新',
    summary: '連携先のシークレットをローテーションします。',
    mission_id: 'MIS-PRODUCTION-WIRING-TEST',
  }),
  '```',
].join('\n');

const COMPLIANT_REPLY = [
  '依頼内容を理解しました。連携シークレットの更新計画を提示します。',
  '承認がない場合は待機したままで実行されません。',
  '次のアクション: この計画を承認してください。',
  APPROVAL_BLOCK,
].join('\n\n');

describe('surface approval wiring with the real intent and routing contracts', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv('KYBERION_REASONING_BACKEND', 'stub');
    mocks.ask.mockResolvedValue(COMPLIANT_REPLY);
    mocks.triggerBackgroundReviewFork.mockReturnValue({ review_due: false });
  });

  it('resolves a real approval intent before validating and delivering the surface reply', async () => {
    const { runSurfaceMessageConversation } = await import('./surface-runtime-orchestrator.js');

    const result = await runSurfaceMessageConversation({
      surface: 'telegram',
      channel: 'ops',
      threadTs: 'production-wiring-1',
      text: 'secretを更新して',
      actorId: 'operator-1',
      senderAgentId: 'test-sender',
    });

    expect(result.intentResolution).toMatchObject({
      normalized_intent: 'rotate-integration-secret',
      authority_level: 'approval_required',
      next_action: { kind: 'request_approval' },
    });
    expect(result.approvalRequests).toHaveLength(1);
    expect(result.uxContract).toMatchObject({ valid: true, violations: [] });
    expect(result.text).toContain('承認待ちです。まだ実行していません。');
    // The governed task-session route must stop before invoking a provider.
    expect(mocks.ask).not.toHaveBeenCalled();
  });

  it.each(['slack', 'chronos', 'presence', 'imessage', 'discord', 'telegram'] as const)(
    'keeps approval gating consistent on the %s surface',
    async (surface) => {
      const { runSurfaceMessageConversation } = await import('./surface-runtime-orchestrator.js');

      const result = await runSurfaceMessageConversation({
        surface,
        channel: 'ops',
        threadTs: `production-wiring-${surface}`,
        text: 'secretを更新して',
        actorId: 'operator-1',
        senderAgentId: 'test-sender',
      });

      expect(result.intentResolution).toMatchObject({
        normalized_intent: 'rotate-integration-secret',
        authority_level: 'approval_required',
        next_action: { kind: 'request_approval' },
      });
      expect(result.approvalRequests).toHaveLength(1);
      expect(result.text).toContain('承認待ちです。まだ実行していません。');
      expect(mocks.ask).not.toHaveBeenCalled();
    }
  );
});
