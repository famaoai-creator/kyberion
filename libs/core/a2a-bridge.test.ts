import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { compileSchemaFromPath } from './schema-loader.js';

const mocks = vi.hoisted(() => {
  const warn = vi.fn();
  const info = vi.fn();
  const record = vi.fn();
  const get = vi.fn();
  const getRuntimeIdentity = vi.fn();
  const ensureAgentRuntime = vi.fn();
  const getAgentRuntimeHandle = vi.fn();
  const askAgentRuntime = vi.fn();
  const stopAgentRuntime = vi.fn();
  const ensureAgentRuntimeViaDaemon = vi.fn();
  const createSupervisorBackedAgentHandle = vi.fn();
  const askAgentRuntimeViaDaemon = vi.fn();
  const shutdownAgentRuntimeViaDaemon = vi.fn();
  const toSupervisorEnsurePayload = vi.fn();
  const getAgentManifest = vi.fn();
  const resolveAgentSelectionHints = vi.fn();
  const logAction = vi.fn();
  const appendConversationTurn = vi.fn();
  const readConversationHistory = vi.fn();
  const rehydrateConversation = vi.fn();
  const appendSupervisorEvent = vi.fn();
  return {
    warn,
    info,
    record,
    get,
    getRuntimeIdentity,
    ensureAgentRuntime,
    getAgentRuntimeHandle,
    askAgentRuntime,
    stopAgentRuntime,
    ensureAgentRuntimeViaDaemon,
    createSupervisorBackedAgentHandle,
    askAgentRuntimeViaDaemon,
    shutdownAgentRuntimeViaDaemon,
    toSupervisorEnsurePayload,
    getAgentManifest,
    resolveAgentSelectionHints,
    logAction,
    appendConversationTurn,
    readConversationHistory,
    rehydrateConversation,
    appendSupervisorEvent,
  };
});
const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

vi.mock('./core.js', () => ({
  logger: {
    warn: mocks.warn,
    info: mocks.info,
  },
}));

vi.mock('./agent-registry', () => ({
  agentRegistry: {
    get: mocks.get,
    getRuntimeIdentity: mocks.getRuntimeIdentity,
  },
}));

vi.mock('./agent-runtime-supervisor.js', () => ({
  ensureAgentRuntime: mocks.ensureAgentRuntime,
  getAgentRuntimeHandle: mocks.getAgentRuntimeHandle,
  askAgentRuntime: mocks.askAgentRuntime,
  stopAgentRuntime: mocks.stopAgentRuntime,
  appendSupervisorEvent: mocks.appendSupervisorEvent,
}));

vi.mock('./a2a-conversation-store.js', () => ({
  appendConversationTurn: mocks.appendConversationTurn,
  readConversationHistory: mocks.readConversationHistory,
  rehydrateConversation: mocks.rehydrateConversation,
}));

vi.mock('./agent-runtime-supervisor-client.js', () => ({
  ensureAgentRuntimeViaDaemon: mocks.ensureAgentRuntimeViaDaemon,
  createSupervisorBackedAgentHandle: mocks.createSupervisorBackedAgentHandle,
  askAgentRuntimeViaDaemon: mocks.askAgentRuntimeViaDaemon,
  shutdownAgentRuntimeViaDaemon: mocks.shutdownAgentRuntimeViaDaemon,
  toSupervisorEnsurePayload: mocks.toSupervisorEnsurePayload,
}));

vi.mock('./agent-manifest', () => ({
  getAgentManifest: mocks.getAgentManifest,
  resolveAgentSelectionHints: mocks.resolveAgentSelectionHints,
  loadAgentManifests: vi.fn(),
}));

vi.mock('./audit-chain', () => ({
  auditChain: {
    record: mocks.record,
  },
}));

vi.mock('./kill-switch.js', () => ({
  killSwitch: {
    logAction: mocks.logAction,
  },
  recordGovernanceAction: (agentId: string, operation: string, reason: string, violation = false) =>
    mocks.logAction(agentId, `${operation}:${reason}`, violation),
}));

describe('a2a-bridge', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.getAgentRuntimeHandle.mockReturnValue(null);
    mocks.toSupervisorEnsurePayload.mockImplementation((payload: any) => payload);
    mocks.resolveAgentSelectionHints.mockImplementation((manifest: any) => ({
      provider: manifest.selection_hints?.preferred_provider || manifest.provider || 'gemini',
      modelId:
        manifest.selection_hints?.preferred_modelId || manifest.modelId || 'gemini-2.5-flash',
    }));
  });

  it('signs and verifies messages', async () => {
    const { signA2AMessage, verifyA2ASignature } = await import('./a2a-bridge.js');
    const message = {
      a2a_version: '1.0',
      header: {
        msg_id: 'MSG-1',
        sender: 'kyberion:surface',
        receiver: 'agent-x',
        performative: 'request' as const,
      },
      payload: { text: 'hello' },
    };

    const signature = signA2AMessage(message);
    expect(signature).toHaveLength(64);
    expect(
      verifyA2ASignature({
        ...message,
        header: {
          ...message.header,
          signature,
        },
      })
    ).toBe(true);
  });

  it('rejects missing receivers and missing manifests', async () => {
    const { a2aBridge } = await import('./a2a-bridge.js');

    await expect(
      a2aBridge.route({
        a2a_version: '1.0',
        header: {
          msg_id: 'MSG-1',
          sender: 'sender-x',
          performative: 'request',
        },
        payload: { text: 'hello' },
      })
    ).rejects.toThrow('A2A message missing receiver');

    mocks.getAgentManifest.mockReturnValue(undefined);
    await expect(a2aBridge.ensureAgent('missing-agent')).rejects.toThrow('no agent manifest found');
  });

  it('routes messages, auto-spawns allowed agents, and notifies response handlers', async () => {
    const { a2aBridge } = await import('./a2a-bridge.js');
    mocks.getAgentManifest.mockImplementation((agentId: string) =>
      agentId === 'codex-nerve'
        ? {
            provider: 'codex',
            modelId: 'gpt-5',
            systemPrompt: 'You are nerve',
            capabilities: ['delegate'],
          }
        : undefined
    );
    const handle = { ask: vi.fn(async (prompt: string) => `echo:${prompt}`) };
    mocks.ensureAgentRuntime.mockResolvedValue(handle);
    mocks.ensureAgentRuntimeViaDaemon.mockRejectedValue(new Error('offline'));
    mocks.getAgentRuntimeHandle.mockImplementation((agentId: string) =>
      agentId === 'codex-nerve' ? handle : null
    );
    mocks.askAgentRuntime.mockImplementation(
      async (_agentId: string, prompt: string) => `echo:${prompt}`
    );
    mocks.askAgentRuntimeViaDaemon.mockRejectedValue(new Error('offline'));
    mocks.get.mockImplementation((agentId: string) => {
      if (agentId === 'sender-x') return { status: 'ready' };
      if (agentId === 'codex-nerve') return { status: 'ready' };
      return undefined;
    });

    const envelope = {
      a2a_version: '1.0',
      header: {
        msg_id: 'MSG-1',
        sender: 'sender-x',
        receiver: 'kyberion:nerve:codex',
        conversation_id: 'CONV-1',
        performative: 'request' as const,
      },
      payload: { text: 'delegate this' },
    };
    const responses: unknown[] = [];
    a2aBridge.onResponse('sender-x', (response) => responses.push(response));

    const result = await a2aBridge.route(envelope);

    expect(mocks.ensureAgentRuntime).toHaveBeenCalled();
    expect(mocks.askAgentRuntime).toHaveBeenCalledWith(
      'codex-nerve',
      'delegate this',
      'a2a_bridge',
      expect.objectContaining({
        correlationId: expect.any(String),
      })
    );
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'a2a_route',
        result: 'completed',
      })
    );
    expect(mocks.logAction).toHaveBeenCalledWith('sender-x', 'a2a_route:codex-nerve', false);
    expect(result.header.sender).toBe('codex-nerve');
    expect(result.header.receiver).toBe('sender-x');
    expect(result.payload).toEqual({ text: 'echo:delegate this' });
    expect(responses).toHaveLength(1);
  });

  it('includes intent and context when routing structured payloads', async () => {
    const { a2aBridge } = await import('./a2a-bridge.js');
    const handle = { ask: vi.fn(async () => 'ok') };
    mocks.getAgentManifest.mockReturnValue({
      provider: 'gemini',
      modelId: 'gemini-2.5-pro',
      systemPrompt: 'agent',
      capabilities: ['delegate'],
    });
    mocks.ensureAgentRuntime.mockResolvedValue(handle);
    mocks.ensureAgentRuntimeViaDaemon.mockRejectedValue(new Error('offline'));
    mocks.getAgentRuntimeHandle.mockImplementation((agentId: string) =>
      agentId === 'nerve-agent' ? handle : null
    );
    mocks.askAgentRuntime.mockResolvedValue('ok');
    mocks.askAgentRuntimeViaDaemon.mockRejectedValue(new Error('offline'));
    mocks.get.mockImplementation((agentId: string) => {
      if (agentId === 'sender-x' || agentId === 'nerve-agent') return { status: 'ready' };
      return undefined;
    });

    await a2aBridge.route({
      a2a_version: '1.0',
      header: {
        msg_id: 'MSG-CTX-1',
        sender: 'sender-x',
        receiver: 'nerve-agent',
        performative: 'request',
      },
      payload: {
        intent: 'request_marketing_material',
        task_model_hint: {
          tier: 'small',
          effort: 'low',
          model_id: 'openai:gpt-5.4-mini',
          route_reason: 'phase_kind=mechanical -> small/low',
        },
        objective: 'create a concise product brief',
        acceptance_criteria: ['brief is concise', 'brief is actionable'],
        expected_outputs: ['product brief markdown'],
        rationale: 'The requester needs a concise report',
        prior_decisions: ['Prefer summary-first output'],
        text: 'Kyberionの資料を作って欲しいんだけど可能かな？',
        context: {
          mission_id: 'MSN-A2A-1',
          team_role: 'mission-controller',
          channel: 'slack',
          execution_mode: 'conversation',
          correlation_id: 'corr-a2a-1',
          user_language: 'ja',
        },
      },
    });

    expect(mocks.askAgentRuntime).toHaveBeenCalledWith(
      'nerve-agent',
      expect.stringContaining('Objective: create a concise product brief'),
      'a2a_bridge',
      expect.objectContaining({
        correlationId: 'corr-a2a-1',
        taskModelHint: expect.objectContaining({
          model_id: 'openai:gpt-5.4-mini',
          tier: 'small',
          effort: 'low',
          route_reason: 'phase_kind=mechanical -> small/low',
        }),
      })
    );
    expect(mocks.askAgentRuntime.mock.calls[0][1]).toContain('Acceptance criteria:');
    expect(mocks.askAgentRuntime.mock.calls[0][1]).toContain('Expected outputs:');
    expect(mocks.askAgentRuntime.mock.calls[0][1]).toContain('Prior decisions:');

    expect(mocks.ensureAgentRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeMetadata: expect.objectContaining({
          task_model_hint: expect.objectContaining({
            model_id: 'openai:gpt-5.4-mini',
            tier: 'small',
            effort: 'low',
            route_reason: 'phase_kind=mechanical -> small/low',
          }),
        }),
      })
    );
  });

  it('honors an explicit mission provider and model target over the agent manifest hint', async () => {
    const { a2aBridge } = await import('./a2a-bridge.js');
    const handle = { ask: vi.fn(async () => 'ok') };
    mocks.getAgentManifest.mockReturnValue({
      selection_hints: {
        preferred_provider: 'agy',
        preferred_modelId: 'Gemini 3.5 Flash (Medium)',
      },
      systemPrompt: 'agent',
      capabilities: ['delegate'],
    });
    mocks.ensureAgentRuntime.mockResolvedValue(handle);
    mocks.ensureAgentRuntimeViaDaemon.mockRejectedValue(new Error('offline'));
    mocks.getAgentRuntimeHandle.mockReturnValue(null);
    mocks.askAgentRuntime.mockResolvedValue('ok');
    mocks.askAgentRuntimeViaDaemon.mockRejectedValue(new Error('offline'));
    mocks.get.mockReturnValue(undefined);

    await a2aBridge.route({
      a2a_version: '1.0',
      header: {
        msg_id: 'MSG-PROVIDER-TARGET-1',
        sender: 'kyberion:mission-orchestrator',
        receiver: 'planner-agent',
        performative: 'request',
      },
      payload: {
        intent: 'mission_task_execution',
        text: 'run the assigned mission task',
        context: {
          mission_id: 'MISSION-PROVIDER-TARGET-1',
          team_role: 'planner',
          execution_mode: 'task',
          provider: 'codex',
          provider_model_id: 'gpt-5.6-sol',
        },
      },
    });

    expect(mocks.ensureAgentRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'codex',
        modelId: 'gpt-5.6-sol',
        runtimeMetadata: expect.objectContaining({
          provider_strategy: 'strict',
          skip_provider_resolution: true,
        }),
      })
    );
  });

  it('rejects structured task payloads that miss required contract fields', async () => {
    const { a2aBridge } = await import('./a2a-bridge.js');
    mocks.getAgentManifest.mockReturnValue({
      provider: 'gemini',
      modelId: 'gemini-2.5-pro',
      systemPrompt: 'agent',
      capabilities: ['delegate'],
    });
    mocks.ensureAgentRuntimeViaDaemon.mockRejectedValue(new Error('offline'));
    mocks.ensureAgentRuntime.mockResolvedValue({ ask: vi.fn(async () => 'ok') });
    mocks.getAgentRuntimeHandle.mockReturnValue(null);
    mocks.get.mockReturnValue({ status: 'ready' });

    await expect(
      a2aBridge.route({
        a2a_version: '1.0',
        header: {
          msg_id: 'MSG-BAD-1',
          sender: 'sender-x',
          receiver: 'nerve-agent',
          performative: 'request',
        },
        payload: {
          intent: 'request_marketing_material',
          text: 'Kyberionの資料を作って',
          context: {
            mission_id: 'MSN-1',
            execution_mode: 'conversation',
          },
        },
      })
    ).rejects.toThrow('A2A task contract validation failed');
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'a2a_task_contract_invalid',
        result: 'denied',
      })
    );
    expect(mocks.logAction).toHaveBeenCalledWith(
      'sender-x',
      'a2a_task_contract_invalid:system',
      true
    );
  });

  it('spawns conversation-mode agents inside a conversation sandbox cwd', async () => {
    const { a2aBridge } = await import('./a2a-bridge.js');
    mocks.getAgentManifest.mockReturnValue({
      provider: 'gemini',
      modelId: 'gemini-2.5-pro',
      systemPrompt: 'agent',
      capabilities: ['delegate'],
    });
    const handle = { ask: vi.fn(async () => 'ok') };
    mocks.ensureAgentRuntime.mockResolvedValue(handle);
    mocks.ensureAgentRuntimeViaDaemon.mockRejectedValue(new Error('offline'));
    mocks.getAgentRuntimeHandle.mockImplementation((agentId: string) =>
      agentId === 'nerve-agent' ? handle : null
    );
    mocks.askAgentRuntime.mockResolvedValue('ok');
    mocks.askAgentRuntimeViaDaemon.mockRejectedValue(new Error('offline'));
    mocks.get.mockReturnValue(undefined);

    await a2aBridge.route({
      a2a_version: '1.0',
      header: {
        msg_id: 'MSG-CWD-1',
        sender: 'sender-x',
        receiver: 'nerve-agent',
        performative: 'request',
      },
      payload: {
        intent: 'request_marketing_material',
        text: 'Kyberionのコンセプトを説明して',
        context: {
          mission_id: 'MSN-A2A-2',
          team_role: 'mission-controller',
          channel: 'slack',
          thread: '1773596301.435519',
          execution_mode: 'conversation',
        },
      },
    });

    expect(mocks.ensureAgentRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: expect.stringContaining(
          'active/shared/tmp/agent-runtime-roots/conversation/slack/1773596301.435519/nerve-agent'
        ),
      })
    );
  });

  it('denies invalid signatures and accepts unsigned internal senders', async () => {
    const { a2aBridge } = await import('./a2a-bridge.js');
    mocks.getAgentManifest.mockReturnValue({
      provider: 'gemini',
      modelId: 'gemini-1.5-pro',
      systemPrompt: 'agent',
      capabilities: [],
    });
    const handle = { ask: vi.fn(async () => 'ok') };
    mocks.ensureAgentRuntime.mockResolvedValue(handle);
    mocks.ensureAgentRuntimeViaDaemon.mockRejectedValue(new Error('offline'));
    mocks.getAgentRuntimeHandle.mockImplementation((agentId: string) =>
      agentId === 'agent-y' ? handle : null
    );
    mocks.askAgentRuntime.mockResolvedValue('ok');
    mocks.askAgentRuntimeViaDaemon.mockRejectedValue(new Error('offline'));

    await expect(
      a2aBridge.route({
        a2a_version: '1.0',
        header: {
          msg_id: 'MSG-2',
          sender: 'kyberion:gateway',
          receiver: 'agent-y',
          performative: 'request',
          signature: 'deadbeef',
        },
        payload: 'hello',
      })
    ).rejects.toThrow(/signature/);

    await expect(
      a2aBridge.route({
        a2a_version: '1.0',
        header: {
          msg_id: 'MSG-3',
          sender: 'kyberion:gateway',
          receiver: 'agent-y',
          performative: 'request',
        },
        payload: 'hello',
      })
    ).resolves.toMatchObject({
      payload: { text: 'ok' },
    });
  });

  it('prefers supervisor daemon for ensure and ask when available', async () => {
    const { a2aBridge } = await import('./a2a-bridge.js');
    const daemonHandle = { ask: vi.fn(async () => 'unused') };
    mocks.getAgentManifest.mockReturnValue({
      provider: 'gemini',
      modelId: 'gemini-2.5-pro',
      systemPrompt: 'agent',
      capabilities: ['delegate'],
    });
    mocks.ensureAgentRuntimeViaDaemon.mockResolvedValue({
      agent_id: 'nerve-agent',
      provider: 'gemini',
      model_id: 'gemini-2.5-pro',
      status: 'ready',
      session_id: 'sess-1',
    });
    mocks.createSupervisorBackedAgentHandle.mockReturnValue(daemonHandle);
    mocks.askAgentRuntimeViaDaemon.mockResolvedValue({ text: 'daemon-ok' });
    mocks.get.mockImplementation((agentId: string) => {
      if (agentId === 'sender-x' || agentId === 'nerve-agent') return { status: 'ready' };
      return undefined;
    });

    const result = await a2aBridge.route({
      a2a_version: '1.0',
      header: {
        msg_id: 'MSG-DAEMON-1',
        sender: 'sender-x',
        receiver: 'nerve-agent',
        performative: 'request',
      },
      payload: { text: 'delegate this through daemon' },
    });

    expect(mocks.ensureAgentRuntimeViaDaemon).toHaveBeenCalledTimes(1);
    expect(mocks.createSupervisorBackedAgentHandle).toHaveBeenCalled();
    expect(mocks.askAgentRuntimeViaDaemon).toHaveBeenCalledWith({
      agentId: 'nerve-agent',
      prompt: 'delegate this through daemon',
      requestedBy: 'a2a_bridge',
      correlationId: expect.any(String),
    });
    expect(mocks.ensureAgentRuntime).not.toHaveBeenCalled();
    expect(result.payload).toEqual({ text: 'daemon-ok' });
  });

  it('forwards a mission dispatch budget to the supervisor ask transport', async () => {
    const { a2aBridge } = await import('./a2a-bridge.js');
    mocks.getAgentManifest.mockReturnValue({
      provider: 'codex',
      modelId: 'gpt-5.6-luna',
      systemPrompt: 'agent',
      capabilities: ['delegate'],
    });
    mocks.ensureAgentRuntimeViaDaemon.mockResolvedValue({
      agent_id: 'codex-nerve',
      provider: 'codex',
      model_id: 'gpt-5.6-luna',
      status: 'ready',
      session_id: 'sess-luna',
    });
    mocks.createSupervisorBackedAgentHandle.mockReturnValue({ ask: vi.fn() });
    mocks.askAgentRuntimeViaDaemon.mockResolvedValue({ text: 'task-result' });

    await a2aBridge.route({
      a2a_version: '1.0',
      header: {
        msg_id: 'MSG-DISPATCH-TIMEOUT-1',
        sender: 'sender-x',
        receiver: 'codex-nerve',
        performative: 'request',
      },
      payload: {
        intent: 'mission_task_execution',
        text: 'complete the bounded task',
        context: {
          mission_id: 'MSN-TIMEOUT',
          team_role: 'researcher',
          task_id: 'TASK-1',
          execution_mode: 'task',
          dispatch_timeout_ms: 180_000,
        },
      },
    });

    expect(mocks.askAgentRuntimeViaDaemon).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'codex-nerve',
        timeoutMs: 180_000,
      })
    );
  });

  it('emits a2a envelopes that satisfy the schema', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      path.resolve(process.cwd(), 'schemas/a2a-envelope.schema.json')
    );

    expect(
      validate({
        a2a_version: '1.0',
        header: {
          msg_id: 'MSG-1',
          sender: 'sender-x',
          receiver: 'agent-y',
          performative: 'request',
        },
        payload: {
          text: 'hello',
        },
      }),
      JSON.stringify(validate.errors || [])
    ).toBe(true);
  });

  it('rejects invalid a2a envelopes', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      path.resolve(process.cwd(), 'schemas/a2a-envelope.schema.json')
    );

    expect(
      validate({
        a2a_version: '2.0',
        header: {
          msg_id: 'MSG-1',
          sender: 'sender-x',
          performative: 'request',
        },
        payload: {},
      })
    ).toBe(false);
  });

  describe('NI-02 sender_nhi_id claim', () => {
    const savedSecret = process.env.KYBERION_A2A_SECRET;
    const savedActorMode = process.env.KYBERION_NHI_ACTOR;

    beforeEach(async () => {
      process.env.KYBERION_A2A_SECRET = 'ni02-bridge-test-secret';
      delete process.env.KYBERION_NHI_ACTOR;
      // The a2aBridge singleton lives on globalThis (Symbol.for) and survives
      // vi.resetModules(): a stale instance would keep using the PREVIOUS
      // module generation's signature/identity modules while the test imports
      // fresh ones. Drop it so this generation rebuilds a consistent instance.
      delete (globalThis as Record<symbol, unknown>)[Symbol.for('@kyberion/a2a-bridge')];
      const { resetA2ASecretCache } = await import('./a2a-envelope-signature.js');
      resetA2ASecretCache();
    });

    afterEach(async () => {
      if (savedSecret === undefined) delete process.env.KYBERION_A2A_SECRET;
      else process.env.KYBERION_A2A_SECRET = savedSecret;
      if (savedActorMode === undefined) delete process.env.KYBERION_NHI_ACTOR;
      else process.env.KYBERION_NHI_ACTOR = savedActorMode;
      const { setNhiActorAuditSinkForTests, clearNhiActorVerificationCache } =
        await import('./nhi-actor-verification.js');
      setNhiActorAuditSinkForTests(null);
      clearNhiActorVerificationCache();
      const { resetAgentIdentityServiceForTests } = await import('./agent-identity.js');
      resetAgentIdentityServiceForTests();
      const { pathResolver } = await import('./path-resolver.js');
      const { safeExistsSync, safeRmSync } = await import('./secure-io.js');
      const tmpDir = pathResolver.rootResolve(`active/shared/tmp/ni02-bridge-tests-${process.pid}`);
      if (safeExistsSync(tmpDir)) safeRmSync(tmpDir, { recursive: true, force: true });
      // Leave no cross-generation singleton behind for later describes.
      delete (globalThis as Record<symbol, unknown>)[Symbol.for('@kyberion/a2a-bridge')];
    });

    function baseRouteMocks(agentId: string) {
      mocks.getAgentManifest.mockReturnValue({
        provider: 'gemini',
        modelId: 'gemini-2.5-pro',
        systemPrompt: 'agent',
        capabilities: ['delegate'],
      });
      const handle = { ask: vi.fn(async () => 'ok') };
      mocks.ensureAgentRuntime.mockResolvedValue(handle);
      mocks.ensureAgentRuntimeViaDaemon.mockRejectedValue(new Error('offline'));
      mocks.getAgentRuntimeHandle.mockImplementation((id: string) =>
        id === agentId ? handle : null
      );
      mocks.askAgentRuntime.mockResolvedValue('ok');
      mocks.askAgentRuntimeViaDaemon.mockRejectedValue(new Error('offline'));
      mocks.get.mockReturnValue({ status: 'ready' });
    }

    it('stamps the responder identity inside the signed response; tampering breaks verification', async () => {
      const { a2aBridge, verifyA2ASignature } = await import('./a2a-bridge.js');
      baseRouteMocks('nerve-agent');
      mocks.getRuntimeIdentity.mockImplementation((id: string) =>
        id === 'nerve-agent' ? 'kyberion://agent/ni02-org/nerve-agent' : undefined
      );

      const response = await a2aBridge.route({
        a2a_version: '1.0',
        header: {
          msg_id: 'MSG-NI02-1',
          sender: 'kyberion:gateway',
          receiver: 'nerve-agent',
          performative: 'request',
        },
        payload: { text: 'hello' },
      });

      expect(response.header.sender_nhi_id).toBe('kyberion://agent/ni02-org/nerve-agent');
      expect(verifyA2ASignature(response)).toBe(true);

      // Altering the claim after signing must break the signature.
      const tampered = {
        ...response,
        header: { ...response.header, sender_nhi_id: 'kyberion://agent/ni02-org/impostor' },
      };
      expect(verifyA2ASignature(tampered)).toBe(false);

      // Stripping the claim must break it too (claim is inside the HMAC).
      const stripped = { ...response, header: { ...response.header } };
      delete stripped.header.sender_nhi_id;
      expect(verifyA2ASignature(stripped)).toBe(false);
    });

    it('emits claim-less (still verifiable) envelopes when no identity is stamped in the registry', async () => {
      const { a2aBridge, verifyA2ASignature } = await import('./a2a-bridge.js');
      baseRouteMocks('nerve-agent');
      mocks.getRuntimeIdentity.mockReturnValue(undefined);

      const response = await a2aBridge.route({
        a2a_version: '1.0',
        header: {
          msg_id: 'MSG-NI02-2',
          sender: 'kyberion:gateway',
          receiver: 'nerve-agent',
          performative: 'request',
        },
        payload: { text: 'hello' },
      });

      expect(response.header.sender_nhi_id).toBeUndefined();
      expect(verifyA2ASignature(response)).toBe(true);
    });

    it('exposes the sender claim only when the signature is valid (extractVerifiedSenderNhiId)', async () => {
      const { signA2AMessage, extractVerifiedSenderNhiId } = await import('./a2a-bridge.js');
      const message = {
        a2a_version: '1.0',
        header: {
          msg_id: 'MSG-NI02-3',
          sender: 'kyberion:gateway',
          receiver: 'nerve-agent',
          performative: 'request' as const,
          sender_nhi_id: 'kyberion://agent/ni02-org/worker-a',
        },
        payload: { text: 'hello' },
      };
      const signed = {
        ...message,
        header: { ...message.header, signature: signA2AMessage(message) },
      };
      expect(extractVerifiedSenderNhiId(signed)).toBe('kyberion://agent/ni02-org/worker-a');

      const tampered = {
        ...signed,
        header: { ...signed.header, sender_nhi_id: 'kyberion://agent/ni02-org/impostor' },
      };
      expect(extractVerifiedSenderNhiId(tampered)).toBeUndefined();
      expect(extractVerifiedSenderNhiId(message)).toBeUndefined(); // unsigned claim
    });

    it('rejects a retired sender identity under KYBERION_NHI_ACTOR=enforce with a typed error + audit event', async () => {
      const { a2aBridge } = await import('./a2a-bridge.js');
      const { withExecutionContext } = await import('./authority.js');
      const identity = await import('./agent-identity.js');
      const verification = await import('./nhi-actor-verification.js');

      identity.resetAgentIdentityServiceForTests(
        `active/shared/tmp/ni02-bridge-tests-${process.pid}/agent-identities-${Date.now()}.jsonl`
      );
      const retired = withExecutionContext('mission_controller', () => {
        const record = identity.issueAgentIdentity({
          kind: 'agent',
          organizationId: 'ni02-org',
          slug: 'retired-sender',
          accountableHumanId: 'human:founder',
        });
        return identity.retireAgentIdentity(record.nhi_id, 'ni02 test');
      });
      verification.clearNhiActorVerificationCache();
      const sinkEvents: unknown[] = [];
      verification.setNhiActorAuditSinkForTests((event) => sinkEvents.push(event));
      process.env.KYBERION_NHI_ACTOR = 'enforce';

      await expect(
        a2aBridge.route({
          a2a_version: '1.0',
          header: {
            msg_id: 'MSG-NI02-4',
            sender: 'kyberion:gateway',
            receiver: 'nerve-agent',
            performative: 'request',
            sender_nhi_id: retired.nhi_id,
          },
          payload: { text: 'hello' },
        })
      ).rejects.toThrow(verification.NhiActorPolicyError);

      expect(sinkEvents).toEqual([
        expect.objectContaining({
          action: 'nhi_actor_inactive',
          actor: retired.nhi_id,
          verdict: 'retired',
          context: 'a2a-bridge.route.sender_nhi_id',
          result: 'denied',
        }),
      ]);
    });
  });

  describe('NI-03 delegation_chain claim', () => {
    const savedSecret = process.env.KYBERION_A2A_SECRET;

    beforeEach(async () => {
      process.env.KYBERION_A2A_SECRET = 'ni03-bridge-test-secret';
      // See NI-02 describe: the a2aBridge singleton survives vi.resetModules().
      delete (globalThis as Record<symbol, unknown>)[Symbol.for('@kyberion/a2a-bridge')];
      const { resetA2ASecretCache } = await import('./a2a-envelope-signature.js');
      resetA2ASecretCache();
    });

    afterEach(async () => {
      if (savedSecret === undefined) delete process.env.KYBERION_A2A_SECRET;
      else process.env.KYBERION_A2A_SECRET = savedSecret;
      const { resetA2ASecretCache } = await import('./a2a-envelope-signature.js');
      resetA2ASecretCache();
      delete (globalThis as Record<symbol, unknown>)[Symbol.for('@kyberion/a2a-bridge')];
    });

    function baseRouteMocks(agentId: string) {
      mocks.getAgentManifest.mockReturnValue({
        provider: 'gemini',
        modelId: 'gemini-2.5-pro',
        systemPrompt: 'agent',
        capabilities: ['delegate'],
      });
      const handle = { ask: vi.fn(async () => 'ok') };
      mocks.ensureAgentRuntime.mockResolvedValue(handle);
      mocks.ensureAgentRuntimeViaDaemon.mockRejectedValue(new Error('offline'));
      mocks.getAgentRuntimeHandle.mockImplementation((id: string) =>
        id === agentId ? handle : null
      );
      mocks.askAgentRuntime.mockResolvedValue('ok');
      mocks.askAgentRuntimeViaDaemon.mockRejectedValue(new Error('offline'));
      mocks.get.mockReturnValue({ status: 'ready' });
    }

    function sampleChain() {
      return [
        {
          actor: 'kyberion://agent/ni03-org/mission-orchestrator',
          team_role: 'orchestrator',
          granted_scope: {},
          granted_at: '2026-07-26T00:00:00.000Z',
        },
        {
          actor: 'kyberion://agent/ni03-org/worker-a',
          team_role: 'implementer',
          granted_scope: { capability_tier: 'implementer' as const },
          granted_at: '2026-07-26T00:00:01.000Z',
        },
      ];
    }

    it('a signed chain survives route: validated on ingress, echoed inside the signed response, audited', async () => {
      const { a2aBridge, signA2AMessage, verifyA2ASignature, extractVerifiedDelegationChain } =
        await import('./a2a-bridge.js');
      const { serializeDelegationChain } = await import('./delegation-chain.js');
      baseRouteMocks('nerve-agent');

      const chain = sampleChain();
      const message = {
        a2a_version: '1.0',
        header: {
          msg_id: 'MSG-NI03-1',
          sender: 'kyberion:gateway',
          receiver: 'nerve-agent',
          performative: 'request' as const,
          delegation_chain: serializeDelegationChain(chain),
        },
        payload: { text: 'hello' },
      };
      const signed = {
        ...message,
        header: { ...message.header, signature: signA2AMessage(message) },
      };

      const response = await a2aBridge.route(signed);

      // Chain survived the round trip inside the signed result envelope.
      expect(response.header.delegation_chain).toBe(serializeDelegationChain(chain));
      expect(verifyA2ASignature(response)).toBe(true);
      expect(extractVerifiedDelegationChain(response)).toEqual(chain);

      // The a2a_route audit record attributes the routed work to the chain root.
      const routeRecord = mocks.record.mock.calls
        .map((call) => call[0])
        .find((entry) => entry.action === 'a2a_route');
      expect(routeRecord?.metadata).toMatchObject({
        delegation_root_actor: 'kyberion://agent/ni03-org/mission-orchestrator',
        delegation_chain_length: 2,
      });
    });

    it('tampering with the chain breaks the signature and hides the claim (extractVerifiedDelegationChain)', async () => {
      const { signA2AMessage, verifyA2ASignature, extractVerifiedDelegationChain } =
        await import('./a2a-bridge.js');
      const { serializeDelegationChain } = await import('./delegation-chain.js');
      const chain = sampleChain();
      const message = {
        a2a_version: '1.0',
        header: {
          msg_id: 'MSG-NI03-2',
          sender: 'kyberion:gateway',
          receiver: 'nerve-agent',
          performative: 'request' as const,
          delegation_chain: serializeDelegationChain(chain),
        },
        payload: { text: 'hello' },
      };
      const signed = {
        ...message,
        header: { ...message.header, signature: signA2AMessage(message) },
      };
      expect(extractVerifiedDelegationChain(signed)).toEqual(chain);

      const tamperedChain = sampleChain();
      tamperedChain[1].actor = 'kyberion://agent/ni03-org/impostor';
      const tampered = {
        ...signed,
        header: { ...signed.header, delegation_chain: serializeDelegationChain(tamperedChain) },
      };
      expect(verifyA2ASignature(tampered)).toBe(false);
      expect(extractVerifiedDelegationChain(tampered)).toBeUndefined();

      // Stripping a present chain also breaks the signature (claim is inside the HMAC).
      const stripped = { ...signed, header: { ...signed.header } };
      delete (stripped.header as { delegation_chain?: string }).delegation_chain;
      expect(verifyA2ASignature(stripped)).toBe(false);
    });

    it('chain-less envelopes stay byte-compatible: same signature with and without the (absent) field', async () => {
      const { signA2AMessage } = await import('./a2a-bridge.js');
      const legacy = {
        a2a_version: '1.0',
        header: {
          msg_id: 'MSG-NI03-3',
          sender: 'kyberion:gateway',
          receiver: 'nerve-agent',
          performative: 'request' as const,
        },
        payload: { text: 'hello' },
      };
      const withUndefined = {
        ...legacy,
        header: { ...legacy.header, delegation_chain: undefined },
      };
      expect(signA2AMessage(withUndefined as never)).toBe(signA2AMessage(legacy));
    });

    it('rejects an attenuation-violating chain fail-closed before any dispatch', async () => {
      const { a2aBridge, signA2AMessage } = await import('./a2a-bridge.js');
      const { DelegationAttenuationError, serializeDelegationChain } =
        await import('./delegation-chain.js');
      baseRouteMocks('nerve-agent');

      // Child (implementer) outranks its parent grant (explorer).
      const violating = sampleChain();
      violating[0].granted_scope = { capability_tier: 'explorer' as const };
      const message = {
        a2a_version: '1.0',
        header: {
          msg_id: 'MSG-NI03-4',
          sender: 'kyberion:gateway',
          receiver: 'nerve-agent',
          performative: 'request' as const,
          delegation_chain: serializeDelegationChain(violating),
        },
        payload: { text: 'hello' },
      };
      const signed = {
        ...message,
        header: { ...message.header, signature: signA2AMessage(message) },
      };

      await expect(a2aBridge.route(signed)).rejects.toThrow(DelegationAttenuationError);

      // Fail-closed BEFORE dispatch: the agent was never asked.
      expect(mocks.askAgentRuntime).not.toHaveBeenCalled();
      expect(mocks.askAgentRuntimeViaDaemon).not.toHaveBeenCalled();
      const denial = mocks.record.mock.calls
        .map((call) => call[0])
        .find((entry) => entry.action === 'a2a_delegation_attenuation_violation');
      expect(denial?.result).toBe('denied');
    });

    it('rejects a malformed chain header fail-closed before any dispatch', async () => {
      const { a2aBridge } = await import('./a2a-bridge.js');
      const { DelegationAttenuationError } = await import('./delegation-chain.js');
      baseRouteMocks('nerve-agent');

      await expect(
        a2aBridge.route({
          a2a_version: '1.0',
          header: {
            msg_id: 'MSG-NI03-5',
            sender: 'kyberion:gateway',
            receiver: 'nerve-agent',
            performative: 'request',
            delegation_chain: '{not json[',
          },
          payload: { text: 'hello' },
        })
      ).rejects.toThrow(DelegationAttenuationError);
      expect(mocks.askAgentRuntime).not.toHaveBeenCalled();
      expect(mocks.askAgentRuntimeViaDaemon).not.toHaveBeenCalled();
    });
  });

  describe('AA-04 Conversation store and rehydration', () => {
    it('appends conversation turns and rehydrates on session change', async () => {
      const { a2aBridge } = await import('./a2a-bridge.js');
      const mockHandle = {
        agentId: 'nerve-agent',
        getRecord: () => ({ sessionId: 'sess-new' }),
      };
      mocks.get.mockReturnValue({ status: 'ready' });
      mocks.getAgentRuntimeHandle.mockReturnValue(mockHandle);
      mocks.ensureAgentRuntimeViaDaemon.mockResolvedValue({
        agent_id: 'nerve-agent',
        provider: 'gemini',
        session_id: 'sess-new',
      });
      mocks.createSupervisorBackedAgentHandle.mockReturnValue(mockHandle);
      mocks.askAgentRuntimeViaDaemon.mockResolvedValue({ text: 'gemini-ok' });

      // Mock conversation history with old session ID
      mocks.readConversationHistory.mockReturnValue([
        {
          sender: 'sender-x',
          receiver: 'nerve-agent',
          performative: 'request',
          prompt: 'hello',
          provider_session_id: 'sess-old',
        },
      ]);
      mocks.rehydrateConversation.mockReturnValue('REHYDRATE: ');

      const result = await a2aBridge.route({
        a2a_version: '1.0',
        header: {
          msg_id: 'MSG-REHYDRATE-1',
          sender: 'sender-x',
          receiver: 'nerve-agent',
          performative: 'request',
          conversation_id: 'conv-123',
        },
        payload: { text: 'new prompt' },
      });

      expect(mocks.appendConversationTurn).toHaveBeenCalledTimes(2);
      expect(mocks.appendConversationTurn).toHaveBeenNthCalledWith(
        1,
        'conv-123',
        expect.objectContaining({
          prompt: 'new prompt',
        })
      );
      expect(mocks.rehydrateConversation).toHaveBeenCalledWith('conv-123');
      expect(result.payload.metadata.rehydrated).toBe(true);
      expect(mocks.askAgentRuntimeViaDaemon).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'REHYDRATE: new prompt',
        })
      );
    });

    it('rehydrates on AgentRuntimeCrashedError during ask', async () => {
      const { a2aBridge } = await import('./a2a-bridge.js');
      const mockHandle = {
        agentId: 'nerve-agent',
        getRecord: () => ({ sessionId: 'sess-new' }),
      };
      mocks.get.mockReturnValue({ status: 'ready' });
      mocks.getAgentRuntimeHandle.mockReturnValue(mockHandle);
      mocks.ensureAgentRuntimeViaDaemon.mockResolvedValue({
        agent_id: 'nerve-agent',
        provider: 'gemini',
        session_id: 'sess-new',
      });
      mocks.createSupervisorBackedAgentHandle.mockReturnValue(mockHandle);

      const crashErr = new Error('crashed');
      crashErr.name = 'AgentRuntimeCrashedError';

      mocks.askAgentRuntimeViaDaemon
        .mockRejectedValueOnce(crashErr)
        .mockResolvedValueOnce({ text: 'recovered-ok' });

      mocks.readConversationHistory.mockReturnValue([]);
      mocks.rehydrateConversation.mockReturnValue('CRASH_RECOVERY: ');

      const result = await a2aBridge.route({
        a2a_version: '1.0',
        header: {
          msg_id: 'MSG-CRASH-1',
          sender: 'sender-x',
          receiver: 'nerve-agent',
          performative: 'request',
          conversation_id: 'conv-123',
        },
        payload: { text: 'try this' },
      });

      expect(result.payload.metadata.rehydrated).toBe(true);
      expect(mocks.appendSupervisorEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: 'a2a_conversation_rehydrated',
          conversation_id: 'conv-123',
        })
      );
    });

    it('rejects with AgentBusyError when daemon is overloaded', async () => {
      const { a2aBridge } = await import('./a2a-bridge.js');
      const busyErr = new Error('busy');
      (busyErr as any).errorDetail = { type: 'busy', retry_after_ms: 500 };
      mocks.askAgentRuntimeViaDaemon.mockRejectedValueOnce(busyErr);

      let thrown: any;
      try {
        await a2aBridge.route({
          a2a_version: '1.0',
          header: {
            msg_id: 'MSG-BUSY-1',
            sender: 'sender-x',
            receiver: 'nerve-agent',
            performative: 'request',
          },
          payload: { text: 'overload me' },
        });
      } catch (err: any) {
        thrown = err;
      }

      expect(thrown).toBeDefined();
      expect(thrown.name).toBe('AgentBusyError');
      expect(thrown.retryAfterMs).toBe(500);
    });
  });
});
