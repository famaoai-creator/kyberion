import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentFactory, ClaudeAdapter, CodexAdapter, CodexAppServerAdapter } from './agent-adapter.js';

describe('CodexAppServerAdapter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('requests network-enabled sandbox policy for turns', async () => {
    const adapter = new CodexAppServerAdapter({
      cwd: '/tmp/kyberion-test',
      approvalMode: 'relaxed',
    }) as any;

    adapter.threadId = 'thread-1';

    const sendRequest = vi.spyOn(adapter, 'sendRequest').mockImplementation(async (method: string, params: any) => {
      if (method === 'turn/start') return { turn: { id: 'turn-1' } };
      throw new Error(`Unexpected method: ${method}`);
    });

    adapter.earlyTurnResults.set('turn-1', { text: 'OK', stopReason: 'completed' });

    const result = await adapter.ask('Reply with exactly OK');

    expect(result).toEqual({ text: 'OK', stopReason: 'completed' });
    expect(adapter.getSandboxMode()).toBe('workspace-write');
    expect(adapter.buildSandboxPolicy()).toEqual({
      type: 'workspaceWrite',
      writableRoots: undefined,
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    });
    expect(sendRequest).toHaveBeenNthCalledWith(
      1,
      'turn/start',
      expect.objectContaining({
        threadId: 'thread-1',
        sandboxPolicy: {
          type: 'workspaceWrite',
          writableRoots: undefined,
          networkAccess: true,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false,
        },
      }),
      expect.any(Number)
    );
  });

  it('creates provider adapters through the registry-based factory', () => {
    const codexMode = process.env.KYBERION_CODEX_MODE;
    process.env.KYBERION_CODEX_MODE = 'exec';

    try {
      expect(AgentFactory.create('gemini').constructor.name).toBe('GeminiAdapter');
      expect(AgentFactory.create('codex')).toBeInstanceOf(CodexAdapter);
      expect(AgentFactory.create('claude')).toBeInstanceOf(ClaudeAdapter);
    } finally {
      if (codexMode === undefined) {
        delete process.env.KYBERION_CODEX_MODE;
      } else {
        process.env.KYBERION_CODEX_MODE = codexMode;
      }
    }
  });

  it('applies codex enhancers before turn/start', async () => {
    const adapter = new CodexAppServerAdapter({
      cwd: '/tmp/kyberion-test',
      approvalMode: 'relaxed',
    }) as any;

    adapter.threadId = 'thread-1';
    adapter.enhancers = [];
    adapter.addEnhancer({
      name: 'test-enhancer',
      async onBeforeAsk(prompt: string) {
        return { prompt: `${prompt}\n#enhanced` };
      },
    });

    const sendRequest = vi.spyOn(adapter, 'sendRequest').mockImplementation(async (method: string, params: any) => {
      if (method === 'turn/start') {
        return { turn: { id: 'turn-1' } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    adapter.earlyTurnResults.set('turn-1', { text: 'OK', stopReason: 'completed' });
    const result = await adapter.ask('Reply with exactly OK');

    expect(result).toEqual({ text: 'OK', stopReason: 'completed' });
    expect(sendRequest).toHaveBeenCalledWith(
      'turn/start',
      expect.objectContaining({
        input: [{ type: 'text', text: 'Reply with exactly OK\n#enhanced', text_elements: [] }],
      }),
      expect.any(Number)
    );
  });
});
