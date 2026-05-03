import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const getAgentRuntimeHandle = vi.fn();
  const ensureAgentRuntime = vi.fn();
  const ensureAgentRuntimeViaDaemon = vi.fn();
  const createSupervisorBackedAgentHandle = vi.fn();
  const toSupervisorEnsurePayload = vi.fn();
  const getAgentManifest = vi.fn();
  const resolveAgentSelectionHints = vi.fn();

  return {
    getAgentRuntimeHandle,
    ensureAgentRuntime,
    ensureAgentRuntimeViaDaemon,
    createSupervisorBackedAgentHandle,
    toSupervisorEnsurePayload,
    getAgentManifest,
    resolveAgentSelectionHints,
  };
});

vi.mock('./agent-runtime-supervisor.js', () => ({
  getAgentRuntimeHandle: mocks.getAgentRuntimeHandle,
  ensureAgentRuntime: mocks.ensureAgentRuntime,
}));

vi.mock('./agent-runtime-supervisor-client.js', () => ({
  ensureAgentRuntimeViaDaemon: mocks.ensureAgentRuntimeViaDaemon,
  createSupervisorBackedAgentHandle: mocks.createSupervisorBackedAgentHandle,
  toSupervisorEnsurePayload: mocks.toSupervisorEnsurePayload,
}));

vi.mock('./agent-manifest.js', () => ({
  getAgentManifest: mocks.getAgentManifest,
  resolveAgentSelectionHints: mocks.resolveAgentSelectionHints,
}));

describe('channel-surface supervisor routing', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    mocks.getAgentRuntimeHandle.mockReturnValue(undefined);
    mocks.getAgentManifest.mockReturnValue({
      agentId: 'presence-surface-agent',
      selection_hints: {
        preferred_provider: 'gemini',
        preferred_modelId: 'gemini-2.5-flash',
      },
      provider: 'gemini',
      modelId: 'gemini-2.5-flash',
      systemPrompt: 'test system prompt',
      capabilities: ['presence'],
    });
    mocks.resolveAgentSelectionHints.mockReturnValue({
      provider: 'gemini',
      modelId: 'gemini-2.5-flash',
    });
    mocks.toSupervisorEnsurePayload.mockImplementation((payload) => ({
      routed: 'daemon',
      ...payload,
    }));
  });

  it('prefers the supervisor daemon when it is available', async () => {
    const daemonHandle = {
      agentId: 'presence-surface-agent',
      ask: vi.fn().mockResolvedValue('daemon reply'),
      shutdown: vi.fn(),
      getRecord: vi.fn().mockReturnValue({ status: 'ready' }),
    };

    mocks.ensureAgentRuntimeViaDaemon.mockResolvedValue({
      agent_id: 'presence-surface-agent',
      provider: 'gemini',
      model_id: 'gemini-2.5-flash',
      status: 'ready',
      session_id: 'sess-1',
    });
    mocks.createSupervisorBackedAgentHandle.mockReturnValue(daemonHandle);

    const { runSurfaceConversation } = await import('./channel-surface.js');
    const result = await runSurfaceConversation({
      agentId: 'presence-surface-agent',
      query: 'hello',
      senderAgentId: 'voice-hub',
    });

    expect(mocks.ensureAgentRuntimeViaDaemon).toHaveBeenCalledTimes(1);
    expect(mocks.createSupervisorBackedAgentHandle).toHaveBeenCalledWith(
      'presence-surface-agent',
      'surface_agent',
      expect.objectContaining({ agent_id: 'presence-surface-agent' }),
    );
    expect(mocks.ensureAgentRuntime).not.toHaveBeenCalled();
    expect(result.text).toBe('daemon reply');
  });

  it('routes slack-surface-agent through the supervisor daemon path as well', async () => {
    const daemonHandle = {
      agentId: 'slack-surface-agent',
      ask: vi.fn().mockResolvedValue('daemon slack reply'),
      shutdown: vi.fn(),
      getRecord: vi.fn().mockReturnValue({ status: 'ready' }),
    };

    mocks.ensureAgentRuntimeViaDaemon.mockResolvedValue({
      agent_id: 'slack-surface-agent',
      provider: 'gemini',
      model_id: 'gemini-2.5-flash',
      status: 'ready',
      session_id: 'slack-session',
    });
    mocks.createSupervisorBackedAgentHandle.mockReturnValue(daemonHandle);

    const { runSurfaceConversation } = await import('./channel-surface.js');
    const result = await runSurfaceConversation({
      agentId: 'slack-surface-agent',
      query: 'hello',
      senderAgentId: 'kyberion:slack-bridge',
    });

    expect(result.text).toBe('daemon slack reply');
    expect(mocks.ensureAgentRuntimeViaDaemon).toHaveBeenCalledTimes(1);
    expect(mocks.createSupervisorBackedAgentHandle).toHaveBeenCalledWith(
      'slack-surface-agent',
      'surface_agent',
      expect.objectContaining({ agent_id: 'slack-surface-agent' }),
    );
    expect(mocks.ensureAgentRuntime).not.toHaveBeenCalled();
  });

  it('falls back to legacy in-process spawn when daemon ensure fails', async () => {
    const fallbackHandle = {
      agentId: 'presence-surface-agent',
      ask: vi.fn().mockResolvedValue('fallback reply'),
      shutdown: vi.fn(),
      getRecord: vi.fn().mockReturnValue({ status: 'ready' }),
    };

    mocks.ensureAgentRuntimeViaDaemon.mockRejectedValue(new Error('supervisor unavailable'));
    mocks.ensureAgentRuntime.mockResolvedValue(fallbackHandle);

    const { runSurfaceConversation } = await import('./channel-surface.js');
    const result = await runSurfaceConversation({
      agentId: 'presence-surface-agent',
      query: 'hello again',
      senderAgentId: 'voice-hub',
    });

    expect(mocks.ensureAgentRuntimeViaDaemon).toHaveBeenCalledTimes(1);
    expect(mocks.ensureAgentRuntime).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'presence-surface-agent',
      provider: 'gemini',
      modelId: 'gemini-2.5-flash',
      requestedBy: 'surface_agent',
      runtimeOwnerId: 'presence-surface-agent',
      runtimeOwnerType: 'surface',
    }));
    expect(result.text).toBe('fallback reply');
  });
});
