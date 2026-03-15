import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const warn = vi.fn();
  const info = vi.fn();
  const record = vi.fn();
  const get = vi.fn();
  const spawn = vi.fn();
  const getAgentManifest = vi.fn();
  return {
    warn,
    info,
    record,
    get,
    spawn,
    getAgentManifest,
  };
});

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

vi.mock('./agent-lifecycle', () => ({
  agentLifecycle: {
    spawn: mocks.spawn,
  },
}));

vi.mock('./agent-manifest', () => ({
  getAgentManifest: mocks.getAgentManifest,
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
    const ask = vi.fn(async (prompt: string) => `echo:${prompt}`);
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
    mocks.spawn.mockResolvedValue({ ask });
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

    expect(mocks.spawn).toHaveBeenCalled();
    expect(ask).toHaveBeenCalledWith('delegate this');
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
    const ask = vi.fn(async () => 'ok');
    mocks.getAgentManifest.mockReturnValue({
      provider: 'gemini',
      modelId: 'gemini-2.5-pro',
      systemPrompt: 'agent',
      capabilities: ['delegate'],
    });
    mocks.spawn.mockResolvedValue({ ask });
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

    expect(ask).toHaveBeenCalledWith([
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
    ].join('\n'));
  });

  it('spawns conversation-mode agents inside a conversation sandbox cwd', async () => {
    const { a2aBridge } = await import('./a2a-bridge.js');
    mocks.getAgentManifest.mockReturnValue({
      provider: 'gemini',
      modelId: 'gemini-2.5-pro',
      systemPrompt: 'agent',
      capabilities: ['delegate'],
    });
    mocks.spawn.mockResolvedValue({ ask: vi.fn(async () => 'ok') });
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

    expect(mocks.spawn).toHaveBeenCalledWith(expect.objectContaining({
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
    mocks.spawn.mockResolvedValue({ ask: vi.fn(async () => 'ok') });

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
});
