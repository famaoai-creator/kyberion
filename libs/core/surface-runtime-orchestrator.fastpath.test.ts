import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const safeExec = vi.fn();
  const resolveSurfaceIntent = vi.fn();
  const compileUserIntentFlow = vi.fn();
  return {
    safeExec,
    resolveSurfaceIntent,
    compileUserIntentFlow,
  };
});

vi.mock('./secure-io.js', async () => {
  const actual = await vi.importActual<typeof import('./secure-io.js')>('./secure-io.js');
  return {
    ...actual,
    safeExec: mocks.safeExec,
  };
});

vi.mock('./intent-contract.js', () => ({
  compileUserIntentFlow: mocks.compileUserIntentFlow,
  formatClarificationPacket: vi.fn(() => 'clarification'),
}));

vi.mock('./router-contract.js', () => ({
  resolveSurfaceIntent: mocks.resolveSurfaceIntent,
}));

vi.mock('./surface-runtime-router.js', () => ({
  buildDelegationFallbackText: (query: string) => query,
  deriveSurfaceDelegationReceiver: () => undefined,
  normalizeSurfaceDelegationReceiver: () => undefined,
  parseSlackSurfacePrompt: () => null,
  resolveSurfaceConversationReceiver: () => undefined,
  shouldCompileSurfaceIntent: () => true,
  surfaceChannelFromAgentId: () => 'presence',
  surfaceRoutingText: (input: { query: string }) => ({ text: input.query, parsedSlackPrompt: null }),
}));

describe('surface-runtime-orchestrator fast-path', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.safeExec.mockReturnValue('ok');
    mocks.compileUserIntentFlow.mockResolvedValue({
      intentContract: { resolution: { execution_shape: 'pipeline' } },
      workLoop: {},
    });
  });

  it('executes pipeline hint and emits execution-receipt', async () => {
    mocks.resolveSurfaceIntent.mockReturnValue({
      intentId: 'check-kyberion-baseline',
      shape: 'pipeline',
      pipelineId: 'baseline-check',
    });
    const { runSurfaceConversation } = await import('./surface-runtime-orchestrator.js');
    const result = await runSurfaceConversation({
      agentId: 'presence-surface-agent',
      query: 'Kyberionのベースライン状態を確認して',
      senderAgentId: 'test-sender',
    });
    expect(result.text).toContain('Executed pipeline: baseline-check');
    expect(result.text).toContain('"kind": "execution-receipt"');
    expect(mocks.safeExec).toHaveBeenCalledWith(
      'node',
      ['dist/scripts/run_pipeline.js', '--input', 'pipelines/baseline-check.json'],
      expect.any(Object),
    );
  });

  it('executes mission action hint and emits execution-receipt', async () => {
    mocks.resolveSurfaceIntent.mockReturnValue({
      intentId: 'classify-mission',
      shape: 'mission',
      missionAction: 'classify',
    });
    const { runSurfaceConversation } = await import('./surface-runtime-orchestrator.js');
    const result = await runSurfaceConversation({
      agentId: 'presence-surface-agent',
      missionId: 'MSN-TEST',
      query: 'ミッションを分類して',
      senderAgentId: 'test-sender',
    });
    expect(result.text).toContain('Executed mission action: classify (MSN-TEST)');
    expect(result.text).toContain('"kind": "execution-receipt"');
    expect(mocks.safeExec).toHaveBeenCalledWith(
      'node',
      ['dist/scripts/mission_controller.js', 'classify', 'MSN-TEST'],
      expect.any(Object),
    );
  });
});

