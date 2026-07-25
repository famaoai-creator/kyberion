import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const getAgentRuntimeHandle = vi.fn();
  const ensureAgentRuntime = vi.fn();
  const ensureAgentRuntimeViaDaemon = vi.fn();
  const createSupervisorBackedAgentHandle = vi.fn();
  const toSupervisorEnsurePayload = vi.fn();
  const getAgentManifest = vi.fn();
  const resolveAgentSelectionHints = vi.fn();
  const loggerInfo = vi.fn();
  const a2aRoute = vi.fn();

  return {
    getAgentRuntimeHandle,
    ensureAgentRuntime,
    ensureAgentRuntimeViaDaemon,
    createSupervisorBackedAgentHandle,
    toSupervisorEnsurePayload,
    getAgentManifest,
    resolveAgentSelectionHints,
    loggerInfo,
    a2aRoute,
  };
});

vi.mock('./a2a-bridge.js', () => ({
  a2aBridge: {
    route: mocks.a2aRoute,
  },
}));

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

// SO-05: capture the structured tier-declaration events emitted by
// surface-runtime-orchestrator.ts without silencing every logger in the
// process (only the surface-reasoning-tier channel is asserted on below).
vi.mock('./logger.js', async () => {
  const actual = await vi.importActual<typeof import('./logger.js')>('./logger.js');
  return {
    ...actual,
    createLogger: (name: string, options?: unknown) => {
      const real = actual.createLogger(name, options as any);
      if (name !== 'surface-reasoning-tier') return real;
      return { ...real, info: mocks.loggerInfo };
    },
  };
});

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
      expect.objectContaining({ agent_id: 'presence-surface-agent' })
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
      expect.objectContaining({ agent_id: 'slack-surface-agent' })
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
    expect(mocks.ensureAgentRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'presence-surface-agent',
        provider: 'gemini',
        modelId: 'gemini-2.5-flash',
        requestedBy: 'surface_agent',
        runtimeOwnerId: 'presence-surface-agent',
        runtimeOwnerType: 'surface',
      })
    );
    expect(result.text).toBe('fallback reply');
  });

  describe('SO-05 model-tier declarations on the surface conversation front', () => {
    function stubDaemonHandle(ask: ReturnType<typeof vi.fn>) {
      const daemonHandle = {
        agentId: 'presence-surface-agent',
        ask,
        shutdown: vi.fn(),
        getRecord: vi.fn().mockReturnValue({ status: 'ready' }),
      };
      mocks.ensureAgentRuntimeViaDaemon.mockResolvedValue({
        agent_id: 'presence-surface-agent',
        provider: 'gemini',
        model_id: 'gemini-2.5-flash',
        status: 'ready',
        session_id: 'sess-tier',
      });
      mocks.createSupervisorBackedAgentHandle.mockReturnValue(daemonHandle);
      return daemonHandle;
    }

    it('declares model_tier fast on the main surface-agent ask', async () => {
      // A signal-bearing reply (contains "Result:") passes UX-contract
      // validation on the first try, so no escalation happens here — this
      // isolates the base-case fast declaration from the escalation path.
      const ask = vi.fn().mockResolvedValue('Result: hello back');
      stubDaemonHandle(ask);

      const { runSurfaceConversation } = await import('./channel-surface.js');
      const result = await runSurfaceConversation({
        agentId: 'presence-surface-agent',
        query: 'hello',
        senderAgentId: 'voice-hub',
      });

      expect(ask).toHaveBeenCalledTimes(1);
      expect(ask.mock.calls[0][1]).toMatchObject({ model_tier: 'fast' });
      expect(result.text).toBe('Result: hello back');
      expect(mocks.loggerInfo).toHaveBeenCalledWith(
        'surface_reasoning_tier_declared',
        expect.objectContaining({
          call_site: 'surface_main_ask',
          declared_tier: 'fast',
          escalated: false,
        })
      );
    });

    it('escalates exactly once to standard tier when the fast response fails UX-contract validation and cannot be repaired', async () => {
      // "daemon reply" contains none of the UX-contract signal words and
      // nothing repairSurfaceUxContractText's vocabulary rules touch, so it
      // stays invalid after repair on every call — proving the escalation
      // fires at most once even when the standard-tier retry also fails.
      const ask = vi.fn().mockResolvedValue('daemon reply');
      stubDaemonHandle(ask);

      const { runSurfaceConversation } = await import('./channel-surface.js');
      const result = await runSurfaceConversation({
        agentId: 'presence-surface-agent',
        query: 'hello',
        senderAgentId: 'voice-hub',
      });

      expect(ask).toHaveBeenCalledTimes(2);
      expect(ask.mock.calls[0][1]).toMatchObject({ model_tier: 'fast' });
      expect(ask.mock.calls[1][1]).toMatchObject({ model_tier: 'standard' });
      expect(ask.mock.calls[1][0]).toContain('ux_contract_validation_failed');
      expect(result.text).toBe('daemon reply');

      expect(mocks.loggerInfo).toHaveBeenCalledWith(
        'surface_reasoning_tier_declared',
        expect.objectContaining({
          call_site: 'surface_main_ask',
          declared_tier: 'standard',
          escalated: true,
          escalation_reason: 'ux_contract_validation_failed',
        })
      );
      // Exactly one escalation event — the standard-tier retry's own
      // (also-invalid) output is taken as final, not re-validated/escalated.
      const escalationEvents = mocks.loggerInfo.mock.calls.filter(
        ([, data]) => (data as { escalated?: boolean })?.escalated
      );
      expect(escalationEvents).toHaveLength(1);
    });

    it('declares model_tier fast on the summary ask after a successful delegation', async () => {
      mocks.a2aRoute.mockResolvedValue({
        a2a_version: '1.0',
        header: {
          msg_id: 'RES-TIER-TEST',
          sender: 'nerve-agent',
          receiver: 'presence-surface-agent',
          performative: 'result',
        },
        payload: { text: 'delegated result' },
      });
      const ask = vi
        .fn()
        .mockResolvedValueOnce(
          [
            '```a2a',
            JSON.stringify({
              a2a_version: '1.0',
              header: {
                msg_id: 'REQ-1',
                sender: 'presence-surface-agent',
                performative: 'request',
                receiver: 'nerve-agent',
              },
              payload: { text: 'please handle this' },
            }),
            '```',
          ].join('\n')
        )
        .mockResolvedValueOnce('Result: delegation summary complete');
      stubDaemonHandle(ask);

      const { runSurfaceConversation } = await import('./channel-surface.js');
      const result = await runSurfaceConversation({
        agentId: 'presence-surface-agent',
        query: 'delegate this please',
        senderAgentId: 'voice-hub',
      });

      expect(ask).toHaveBeenCalledTimes(2);
      expect(ask.mock.calls[0][1]).toMatchObject({ model_tier: 'fast' });
      expect(ask.mock.calls[1][1]).toMatchObject({ model_tier: 'fast' });
      expect(result.text).toBe('Result: delegation summary complete');
      expect(mocks.loggerInfo).toHaveBeenCalledWith(
        'surface_reasoning_tier_declared',
        expect.objectContaining({ call_site: 'surface_summary_ask', declared_tier: 'fast' })
      );
    });
  });
});
