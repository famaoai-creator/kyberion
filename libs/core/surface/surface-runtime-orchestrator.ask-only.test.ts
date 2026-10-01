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
  resolveSurfaceConversationReceiver: () => 'nerve-agent',
  shouldCompileSurfaceIntent: () => false,
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
    getAgentRuntimeHandle: () => ({
      ask: mocks.ask,
      getRecord: () => ({ status: 'ready' }),
    }),
  };
});

describe('surface-runtime-orchestrator ask-only work authority', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.resolveSurfaceIntent.mockReturnValue({});
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
    mocks.createTaskSession.mockImplementation((params: any) => ({
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
});
