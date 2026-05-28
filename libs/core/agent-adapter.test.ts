import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentFactory,
  ClaudeAdapter,
  CodexAdapter,
  CodexAppServerAdapter,
  CodexExecutionEnhancer,
  GeminiJsonModeEnforcer,
  GeminiPhaseAwareInstructionEnhancer,
  GeminiWisdomEnhancer,
} from './agent-adapter.js';

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

    expect(result).toEqual(expect.objectContaining({ text: 'OK', stopReason: 'completed' }));
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

    expect(result).toEqual(expect.objectContaining({ text: 'OK', stopReason: 'completed' }));
    expect(sendRequest).toHaveBeenCalledWith(
      'turn/start',
      expect.objectContaining({
        input: [{ type: 'text', text: 'Reply with exactly OK\n#enhanced', text_elements: [] }],
      }),
      expect.any(Number)
    );
  });

  it('applies enhancer option overrides and post-ask transforms', async () => {
    const adapter = new CodexAppServerAdapter({
      cwd: '/tmp/kyberion-test',
      approvalMode: 'relaxed',
    }) as any;

    adapter.threadId = 'thread-1';
    adapter.enhancers = [];
    adapter.addEnhancer({
      name: 'before-after-enhancer',
      async onBeforeAsk(prompt: string, options?: Record<string, unknown>) {
        return {
          prompt: `${prompt}\n#contract`,
          options: { ...(options || {}), model: 'gpt-5.4-mini' },
        };
      },
      async onAfterAsk(response) {
        return { ...response, text: `${response.text}\n#post` };
      },
    });

    const sendRequest = vi.spyOn(adapter, 'sendRequest').mockImplementation(async (method: string) => {
      if (method === 'turn/start') {
        return { turn: { id: 'turn-1' } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    adapter.earlyTurnResults.set('turn-1', { text: 'OK', stopReason: 'completed' });
    const result = await adapter.ask('Reply with exactly OK', { cwd: '/tmp/alt' });

    expect(result).toEqual(expect.objectContaining({ text: 'OK\n#post', stopReason: 'completed' }));
    expect(sendRequest).toHaveBeenCalledWith(
      'turn/start',
      expect.objectContaining({
        input: [{ type: 'text', text: 'Reply with exactly OK\n#contract', text_elements: [] }],
        model: 'gpt-5.4-mini',
        cwd: '/tmp/alt',
      }),
      expect.any(Number)
    );
  });
});

describe('AgentEnhancer parity', () => {
  const ENHANCERS = [
    new GeminiPhaseAwareInstructionEnhancer(),
    new GeminiJsonModeEnforcer(),
    new GeminiWisdomEnhancer(),
    new CodexExecutionEnhancer(),
  ];

  for (const enhancer of ENHANCERS) {
    describe(enhancer.name, () => {
      it('has a non-empty name', () => {
        expect(typeof enhancer.name).toBe('string');
        expect(enhancer.name.length).toBeGreaterThan(0);
      });

      it('onBeforeAsk always returns { prompt: string } without throwing', async () => {
        const result = await enhancer.onBeforeAsk!('hello', {});
        expect(typeof result.prompt).toBe('string');
      });

      it('onBeforeAsk works with an empty prompt and no options', async () => {
        const result = await enhancer.onBeforeAsk!('', undefined);
        expect(typeof result.prompt).toBe('string');
      });

      it('onBeforeAsk does not drop caller options (additive merge)', async () => {
        const callerOptions = { cwd: '/test/dir', model: 'test-model' };
        const result = await enhancer.onBeforeAsk!('test prompt', callerOptions);
        if (result.options) {
          expect(result.options.cwd).toBe('/test/dir');
          expect(result.options.model).toBe('test-model');
        }
      });

      if ('onAfterAsk' in enhancer && typeof (enhancer as any).onAfterAsk === 'function') {
        it('onAfterAsk passes response through without throwing', async () => {
          const response = { text: 'test', stopReason: 'completed' as const };
          const result = await (enhancer as any).onAfterAsk(response);
          expect(typeof result.text).toBe('string');
        });
      }
    });
  }
});
