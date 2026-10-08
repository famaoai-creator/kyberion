// Team Channel P1: ask-only speakers (viewers, unregistered guests) must get a
// direct reply only — no task session, governed execution or delegation, even
// when the request would otherwise start work.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeExec: vi.fn(() => 'ok'),
  a2aRoute: vi.fn(),
  resolveSurfaceIntent: vi.fn(),
  compileUserIntentFlow: vi.fn(),
  classifyTaskSessionIntent: vi.fn(),
  createTaskSession: vi.fn(),
  saveTaskSession: vi.fn(),
  ask: vi.fn(async () => 'direct answer'),
  getAgentRuntimeHandle: vi.fn(),
  ensureAgentRuntime: vi.fn(),
  shouldCompileSurfaceIntent: vi.fn(() => false),
  resolveSurfaceConversationReceiver: vi.fn((): string | undefined => 'nerve-agent'),
  triggerBackgroundReviewFork: vi.fn(() => ({ review_due: false })),
  recordExecutionFeedback: vi.fn(),
  parseExecutionFeedbackText: vi.fn(() => null),
}));

vi.mock('../workforce/background-review-runner.js', () => ({
  triggerBackgroundReviewFork: mocks.triggerBackgroundReviewFork,
}));
vi.mock('../execution-feedback.js', () => ({
  recordExecutionFeedback: mocks.recordExecutionFeedback,
  parseExecutionFeedbackText: mocks.parseExecutionFeedbackText,
}));

vi.mock('../secure-io.js', async () => {
  const actual = await vi.importActual<typeof import('../secure-io.js')>('../secure-io.js');
  return { ...actual, safeExec: mocks.safeExec };
});
vi.mock('../mesh/a2a-bridge.js', () => ({ a2aBridge: { route: mocks.a2aRoute } }));
vi.mock('../intent/intent-contract.js', async () => ({
  ...(await vi.importActual<typeof import('../intent/intent-contract.js')>(
    '../intent/intent-contract.js'
  )),
  compileUserIntentFlow: mocks.compileUserIntentFlow,
}));
vi.mock('../task/task-session.js', () => ({
  classifyTaskSessionIntent: mocks.classifyTaskSessionIntent,
  createTaskSession: mocks.createTaskSession,
  saveTaskSession: mocks.saveTaskSession,
  updateTaskSession: vi.fn(),
  getActiveTaskSession: vi.fn(),
}));
vi.mock('../router-contract.js', () => ({
  resolveSurfaceIntent: mocks.resolveSurfaceIntent,
  resolveDirectIntentCommand: () => null,
}));
vi.mock('./surface-runtime-router.js', () => ({
  buildDelegationFallbackText: (query: string) => query,
  deriveSurfaceDelegationReceiver: () => 'nerve-agent',
  normalizeSurfaceDelegationReceiver: (value?: string) => value,
  parseSlackSurfacePrompt: () => null,
  resolveSurfaceConversationReceiver: mocks.resolveSurfaceConversationReceiver,
  shouldCompileSurfaceIntent: mocks.shouldCompileSurfaceIntent,
  surfaceChannelFromAgentId: () => 'presence',
  surfaceRoutingText: (input: { query: string }) => ({
    text: input.query,
    parsedSlackPrompt: null,
  }),
}));
vi.mock('../agent/agent-runtime-supervisor.js', async () => {
  const actual = await vi.importActual<typeof import('../agent/agent-runtime-supervisor.js')>(
    '../agent/agent-runtime-supervisor.js'
  );
  return {
    ...actual,
    getAgentRuntimeHandle: mocks.getAgentRuntimeHandle,
    ensureAgentRuntime: mocks.ensureAgentRuntime,
  };
});

describe('surface-runtime-orchestrator ask-only work authority', () => {
  beforeEach(() => {
    // No vi.resetModules(): the module under test and the secure-io / tier-guard /
    // authority stack under it are imported once per file (the first `await
    // import`; later ones hit the module cache). Re-importing that stack per test
    // repeated its module initialisation every test (operations-hygiene-runbook §5).
    // Per-test state is the mocks, re-armed below.
    vi.clearAllMocks();
    mocks.resolveSurfaceIntent.mockReturnValue({});
    mocks.getAgentRuntimeHandle.mockReturnValue({
      ask: mocks.ask,
      getRecord: () => ({ status: 'ready' }),
    });
    mocks.resolveSurfaceConversationReceiver.mockReturnValue('nerve-agent');
    mocks.parseExecutionFeedbackText.mockReturnValue(null);
    mocks.classifyTaskSessionIntent.mockReturnValue({
      intentId: 'cross-project-remediation',
      taskType: 'analysis',
      goal: { summary: 'Fix bugs', success_condition: 'Fixed' },
      requirements: { missing: [], collected: {} },
      payload: {},
    });
    mocks.a2aRoute.mockResolvedValue({
      a2a_version: '1.0',
      header: { msg_id: 'R', sender: 'nerve-agent', receiver: 's', performative: 'result' },
      payload: { text: 'delegated work' },
    });
  });

  it('answers directly instead of opening a task session or delegating', async () => {
    const { runSurfaceConversation } = await import('./surface-runtime-orchestrator.js');
    const result = await runSurfaceConversation({
      agentId: 'presence-surface-agent',
      query: '横展開されていないバグを修正して',
      senderAgentId: 'test-sender',
      forcedReceiver: 'nerve-agent',
      workAuthority: 'ask_only',
    });
    expect(mocks.saveTaskSession).not.toHaveBeenCalled();
    expect(mocks.createTaskSession).not.toHaveBeenCalled();
    expect(mocks.a2aRoute).not.toHaveBeenCalled();
    expect(mocks.ask).toHaveBeenCalled();
    expect(result.delegationResults).toEqual([]);
    expect(result.text).toContain('direct answer');
  });

  it('still opens the task session for full-authority speakers', async () => {
    mocks.createTaskSession.mockImplementation((params: Record<string, unknown>) => ({
      session_id: 'TSK-T',
      task_type: params.taskType,
      goal: params.goal,
      requirements: params.requirements,
      payload: params.payload,
      work_loop: { resolution: { execution_shape: 'task_session' } },
      control: { interruptible: true, requires_approval: false, awaiting_user_input: false },
    }));
    const { runSurfaceConversation } = await import('./surface-runtime-orchestrator.js');
    await runSurfaceConversation({
      agentId: 'presence-surface-agent',
      query: '横展開されていないバグを修正して',
      senderAgentId: 'test-sender',
    });
    expect(mocks.createTaskSession).toHaveBeenCalled();
  });

  it('does not write tenant-scoped feedback to the shared execution store', async () => {
    mocks.parseExecutionFeedbackText.mockReturnValue({
      scenario_id: 'use-case-schedule-read-agenda',
      intent_id: 'schedule-read-agenda',
      outcome: 'partially_satisfied',
      correction: '期間を確認して',
    });
    const { runSurfaceConversation } = await import('./surface-runtime-orchestrator.js');
    await runSurfaceConversation({
      agentId: 'presence-surface-agent',
      query: '評価 use-case-schedule-read-agenda: 一部違う: 期間を確認して',
      senderAgentId: 'test-sender',
      scope: { scope_kind: 'tenant', tenant_slug: 'acme', tier: 'confidential' },
    });

    expect(mocks.recordExecutionFeedback).not.toHaveBeenCalled();
  });

  it('runs an isolated tenant turn on a tool-less per-tenant runtime without delegating', async () => {
    mocks.getAgentRuntimeHandle.mockReturnValue(undefined);
    // No rule-based receiver: only the isolation guard keeps the compiler away.
    mocks.resolveSurfaceConversationReceiver.mockReturnValue(undefined);
    mocks.ensureAgentRuntime.mockResolvedValue({
      agentId: 'slack-surface-agent--tenant-acme--confidential',
      ask: mocks.ask,
      getRecord: () => ({ status: 'ready', metadata: { tool_access: 'none' } }),
    });
    const { runSurfaceConversation } = await import('./surface-runtime-orchestrator.js');
    const result = await runSurfaceConversation({
      agentId: 'slack-surface-agent',
      query: '横展開されていないバグを修正して',
      senderAgentId: 'test-sender',
      forcedReceiver: 'nerve-agent',
      isolation: { tenantSlug: 'acme', maxTier: 'confidential' },
    });
    expect(mocks.getAgentRuntimeHandle).toHaveBeenCalledWith(
      'slack-surface-agent--tenant-acme--confidential'
    );
    expect(mocks.getAgentRuntimeHandle).not.toHaveBeenCalledWith('slack-surface-agent');
    expect(mocks.ensureAgentRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'slack-surface-agent--tenant-acme--confidential',
        provider: 'claude',
        runtimeBackend: 'pipe',
        toolAccess: 'none',
        scope: { tenant_slug: 'acme', tier: 'confidential' },
        cwd: expect.stringContaining('isolated-surface/acme-confidential'),
        systemPrompt: expect.stringContaining('Shared team channel mode'),
      })
    );
    expect(mocks.shouldCompileSurfaceIntent).not.toHaveBeenCalled();
    expect(mocks.createTaskSession).not.toHaveBeenCalled();
    expect(mocks.a2aRoute).not.toHaveBeenCalled();
    expect(result.delegationResults).toEqual([]);
  });

  it('refuses to reuse a same-named runtime that was launched with tools', async () => {
    mocks.getAgentRuntimeHandle.mockReturnValue({
      ask: mocks.ask,
      getRecord: () => ({ status: 'ready', metadata: {} }),
    });
    const { runSurfaceConversation } = await import('./surface-runtime-orchestrator.js');
    await expect(
      runSurfaceConversation({
        agentId: 'slack-surface-agent',
        query: 'hello',
        senderAgentId: 'test-sender',
        isolation: { tenantSlug: 'acme', maxTier: 'public' },
      })
    ).rejects.toThrow(/TOOL_LOCKDOWN_MISMATCH/);
    expect(mocks.ask).not.toHaveBeenCalled();
  });

  it('skips the background review fork for isolated message turns only', async () => {
    const { runSurfaceMessageConversation } = await import('./surface-runtime-orchestrator.js');
    const message = {
      surface: 'slack' as const,
      text: 'hello',
      channel: 'C-team',
      threadTs: '1.0',
      senderAgentId: 'test-sender',
      agentId: 'slack-surface-agent',
    };
    mocks.getAgentRuntimeHandle.mockReturnValue({
      ask: mocks.ask,
      getRecord: () => ({ status: 'ready', metadata: { tool_access: 'none' } }),
    });
    await runSurfaceMessageConversation({
      ...message,
      isolation: { tenantSlug: 'acme', maxTier: 'confidential' },
    });
    expect(mocks.triggerBackgroundReviewFork).not.toHaveBeenCalled();
    await runSurfaceMessageConversation(message);
    expect(mocks.triggerBackgroundReviewFork).toHaveBeenCalledTimes(1);
  });
});
