import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexAppServerAdapter } from './agent-adapter.js';

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
});
