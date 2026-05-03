import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { compileSchemaFromPath } from './schema-loader.js';

const mocks = vi.hoisted(() => {
  const warn = vi.fn();
  const info = vi.fn();
  const record = vi.fn();
  const get = vi.fn();
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
  return {
    warn,
    info,
    record,
    get,
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
  },
}));

vi.mock('./agent-runtime-supervisor.js', () => ({
  ensureAgentRuntime: mocks.ensureAgentRuntime,
  getAgentRuntimeHandle: mocks.getAgentRuntimeHandle,
  askAgentRuntime: mocks.askAgentRuntime,
  stopAgentRuntime: mocks.stopAgentRuntime,
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

describe('a2a-bridge', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.getAgentRuntimeHandle.mockReturnValue(null);
    mocks.toSupervisorEnsurePayload.mockImplementation((payload: any) => payload);
    mocks.resolveAgentSelectionHints.mockImplementation((manifest: any) => ({
      provider: manifest.selection_hints?.preferred_provider || manifest.provider || 'gemini',
      modelId: manifest.selection_hints?.preferred_modelId || manifest.modelId || 'gemini-2.5-flash',
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
      }),
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
      }),
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
        : undefined,
    );
    const handle = { ask: vi.fn(async (prompt: string) => `echo:${prompt}`) };
    mocks.ensureAgentRuntime.mockResolvedValue(handle);
    mocks.ensureAgentRuntimeViaDaemon.mockRejectedValue(new Error('offline'));
    mocks.getAgentRuntimeHandle.mockImplementation((agentId: string) => agentId === 'codex-nerve' ? handle : null);
    mocks.askAgentRuntime.mockImplementation(async (_agentId: string, prompt: string) => `echo:${prompt}`);
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
    expect(mocks.askAgentRuntime).toHaveBeenCalledWith('codex-nerve', 'delegate this', 'a2a_bridge');
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'a2a_route',
        result: 'completed',
      }),
    );
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
    mocks.getAgentRuntimeHandle.mockImplementation((agentId: string) => agentId === 'nerve-agent' ? handle : null);
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
        text: 'Kyberionの資料を作って欲しいんだけど可能かな？',
        context: {
          channel: 'slack',
          execution_mode: 'conversation',
          user_language: 'ja',
        },
      },
    });

    expect(mocks.askAgentRuntime).toHaveBeenCalledWith('nerve-agent', [
      'Intent: request_marketing_material',
      '',
      'Context:',
      '{',
      '  "channel": "slack",',
      '  "execution_mode": "conversation",',
      '  "user_language": "ja"',
      '}',
      '',
      'Request:',
      'Kyberionの資料を作って欲しいんだけど可能かな？',
    ].join('\n'), 'a2a_bridge');
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
    mocks.getAgentRuntimeHandle.mockImplementation((agentId: string) => agentId === 'nerve-agent' ? handle : null);
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
          channel: 'slack',
          thread: '1773596301.435519',
          execution_mode: 'conversation',
        },
      },
    });

    expect(mocks.ensureAgentRuntime).toHaveBeenCalledWith(expect.objectContaining({
      cwd: expect.stringContaining('active/shared/tmp/agent-runtime-roots/conversation/slack/1773596301.435519/nerve-agent'),
    }));
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
    mocks.getAgentRuntimeHandle.mockImplementation((agentId: string) => agentId === 'agent-y' ? handle : null);
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
      }),
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
      }),
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
    });
    expect(mocks.ensureAgentRuntime).not.toHaveBeenCalled();
    expect(result.payload).toEqual({ text: 'daemon-ok' });
  });

  it('emits a2a envelopes that satisfy the schema', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.resolve(process.cwd(), 'schemas/a2a-envelope.schema.json'));

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
      JSON.stringify(validate.errors || []),
    ).toBe(true);
  });

  it('rejects invalid a2a envelopes', () => {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(ajv, path.resolve(process.cwd(), 'schemas/a2a-envelope.schema.json'));

    expect(
      validate({
        a2a_version: '2.0',
        header: {
          msg_id: 'MSG-1',
          sender: 'sender-x',
          performative: 'request',
        },
        payload: {},
      }),
    ).toBe(false);
  });
});
