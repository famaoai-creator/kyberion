import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const getAgentRuntimeHandle = vi.fn();
  const ensureAgentRuntime = vi.fn();
  const ensureAgentRuntimeViaDaemon = vi.fn();
  const createSupervisorBackedAgentHandle = vi.fn();
  const toSupervisorEnsurePayload = vi.fn();
  const getAgentManifest = vi.fn();
  const route = vi.fn();

  return {
    getAgentRuntimeHandle,
    ensureAgentRuntime,
    ensureAgentRuntimeViaDaemon,
    createSupervisorBackedAgentHandle,
    toSupervisorEnsurePayload,
    getAgentManifest,
    route,
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
}));

vi.mock('./a2a-bridge.js', () => ({
  a2aBridge: {
    route: mocks.route,
  },
}));

describe('channel-surface presence forced routing', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.getAgentManifest.mockReturnValue({
      provider: 'gemini',
      modelId: 'gemini-2.5-flash',
      systemPrompt: 'test system prompt',
      capabilities: ['presence'],
    });
    mocks.route.mockResolvedValue({
      payload: {
        text: 'Chronos says two missions are active.',
      },
    });
  });

  it('routes forced delegation from presence directly without spawning the surface agent', async () => {
    const { runSurfaceConversation } = await import('./channel-surface.js');
    const result = await runSurfaceConversation({
      agentId: 'presence-surface-agent',
      query: 'ミッション一覧を教えて',
      senderAgentId: 'kyberion:voice-hub',
      forcedReceiver: 'chronos-mirror',
    });

    expect(result.text).toBe('Chronos says two missions are active.');
    expect(mocks.route).toHaveBeenCalledTimes(1);
    expect(mocks.ensureAgentRuntimeViaDaemon).not.toHaveBeenCalled();
    expect(mocks.ensureAgentRuntime).not.toHaveBeenCalled();
  });
});
