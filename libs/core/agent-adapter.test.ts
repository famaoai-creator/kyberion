import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgyAdapter, ClaudeAdapter, CodexAppServerAdapter } from './agent-adapter.js';
import { spawnSync } from 'node:child_process';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

describe('AgyAdapter', () => {
  let adapter: AgyAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new AgyAdapter({ bin: 'agy' });
  });

  it('correctly executes a basic stateless single-prompt run', async () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: 'Hello World',
      stderr: '',
      output: [],
      pid: 123,
      signal: null,
    } as any);

    const response = await adapter.ask('Say hello');
    expect(response.text).toBe('Hello World');
    expect(response.stopReason).toBe('completed');

    expect(spawnSync).toHaveBeenCalledWith(
      'agy',
      ['-p', 'Say hello', '--dangerously-skip-permissions'],
      expect.any(Object)
    );
  });

  it('correctly passes conversationId for session persistence', async () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: 'Response',
      stderr: '',
      output: [],
      pid: 123,
      signal: null,
    } as any);

    await adapter.ask('Continuing...', { conversationId: 'session-123' });

    expect(spawnSync).toHaveBeenCalledWith(
      'agy',
      ['-p', 'Continuing...', '--dangerously-skip-permissions', '--conversation', 'session-123'],
      expect.any(Object)
    );

    const runtimeInfo = adapter.getRuntimeInfo();
    expect(runtimeInfo.stateless).toBe(false);
    expect(runtimeInfo.sessionId).toBe('session-123');
  });

  it('correctly passes addDirs to mount dynamic directories', async () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: 'Response',
      stderr: '',
      output: [],
      pid: 123,
      signal: null,
    } as any);

    await adapter.ask('Check files', { addDirs: ['/path/to/dir1', '/path/to/dir2'] });

    expect(spawnSync).toHaveBeenCalledWith(
      'agy',
      [
        '-p',
        'Check files',
        '--dangerously-skip-permissions',
        '--add-dir',
        '/path/to/dir1',
        '--add-dir',
        '/path/to/dir2',
      ],
      expect.any(Object)
    );
  });

  it('correctly passes sandbox flag', async () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: 'Response',
      stderr: '',
      output: [],
      pid: 123,
      signal: null,
    } as any);

    await adapter.ask('Risky run', { sandbox: true });

    expect(spawnSync).toHaveBeenCalledWith(
      'agy',
      ['-p', 'Risky run', '--dangerously-skip-permissions', '--sandbox'],
      expect.any(Object)
    );
  });

  it('correctly executes in interactive mode with inherited stdio', async () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: '',
      stderr: '',
      output: [],
      pid: 123,
      signal: null,
    } as any);

    const response = await adapter.ask('Interactive prompt', { interactive: true });
    expect(response.text).toBe('Interactive session completed.');
    expect(response.stopReason).toBe('completed');

    expect(spawnSync).toHaveBeenCalledWith(
      'agy',
      ['-i', 'Interactive prompt', '--dangerously-skip-permissions'],
      expect.objectContaining({ stdio: 'inherit' })
    );
  });

  it('passes effort to the Claude CLI when configured', async () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: JSON.stringify({ result: 'ok' }),
      stderr: '',
      output: [],
      pid: 123,
      signal: null,
    } as any);

    const adapter = new ClaudeAdapter({
      model: 'sonnet',
      effort: 'high',
      systemPrompt: 'system',
    });

    const response = await adapter.ask('Do the thing');
    expect(response.text).toBe('ok');

    expect(spawnSync).toHaveBeenCalledWith(
      'claude',
      [
        '-p',
        'Do the thing',
        '--output-format',
        'json',
        '--system-prompt',
        'system',
        '--model',
        'sonnet',
        '--effort',
        'high',
      ],
      expect.any(Object)
    );
  });
});

describe('CodexAppServerAdapter', () => {
  it('projects subagent turns onto configurable medium effort without spawning another process', async () => {
    const adapter = new CodexAppServerAdapter({ timeoutMs: 1000 });
    const requests: any[] = [];
    const fakeChild: any = {
      stdin: {
        writable: true,
        write(payload: string) {
          const request = JSON.parse(payload);
          requests.push(request);
          if (request.method !== 'turn/start') return true;
          setTimeout(() => {
            (adapter as any).handleMessage({
              id: request.id,
              result: { turn: { id: 'turn-native-1' } },
            });
          }, 0);
          setTimeout(() => {
            (adapter as any).handleMessage({
              method: 'item/agentMessage/delta',
              params: { threadId: 'thread-root', turnId: 'turn-native-1', delta: 'native result' },
            });
            (adapter as any).handleMessage({
              method: 'turn/completed',
              params: { turn: { id: 'turn-native-1', status: 'completed' } },
            });
          }, 1);
          return true;
        },
      },
    };
    (adapter as any).child = fakeChild;
    (adapter as any).threadId = 'thread-root';

    const response = await adapter.ask('delegate this', { subagent: true });

    expect(response.text).toBe('native result');
    const turnStart = requests.find((request) => request.method === 'turn/start');
    expect(turnStart.params.threadId).toBe('thread-root');
    expect(turnStart.params.effort).toBe('medium');
    expect(requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
  });

  it('interrupts the active native turn on cancellation without restarting the app-server', async () => {
    const adapter = new CodexAppServerAdapter({ timeoutMs: 1000 });
    const requests: any[] = [];
    const fakeChild: any = {
      stdin: {
        writable: true,
        write(payload: string) {
          const request = JSON.parse(payload);
          requests.push(request);
          if (request.method === 'turn/start') {
            setTimeout(() => {
              (adapter as any).handleMessage({
                id: request.id,
                result: { turn: { id: 'turn-cancel-1' } },
              });
            }, 0);
          } else if (request.method === 'turn/interrupt') {
            setTimeout(() => {
              (adapter as any).handleMessage({ id: request.id, result: {} });
            }, 0);
          }
          return true;
        },
      },
    };
    (adapter as any).child = fakeChild;
    (adapter as any).threadId = 'thread-root';
    const controller = new AbortController();
    const pending = adapter.ask('cancel this', { subagent: true, signal: controller.signal });

    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();

    await expect(pending).rejects.toThrow('cancelled');
    expect(requests.map((request) => request.method)).toEqual(['turn/start', 'turn/interrupt']);
  });

  it('forks a completed parent rollout into a native child thread on the same process', async () => {
    const adapter = new CodexAppServerAdapter({ timeoutMs: 1000 });
    const requests: any[] = [];
    const fakeChild: any = {
      stdin: {
        writable: true,
        write(payload: string) {
          const request = JSON.parse(payload);
          requests.push(request);
          if (request.method === 'thread/fork') {
            setTimeout(() => {
              (adapter as any).handleMessage({
                id: request.id,
                result: { thread: { id: 'thread-child' } },
              });
            }, 0);
          } else if (request.method === 'turn/start') {
            setTimeout(() => {
              (adapter as any).handleMessage({
                id: request.id,
                result: { turn: { id: 'turn-child-1' } },
              });
              (adapter as any).handleMessage({
                method: 'item/agentMessage/delta',
                params: { threadId: 'thread-child', turnId: 'turn-child-1', delta: 'child result' },
              });
              (adapter as any).handleMessage({
                method: 'turn/completed',
                params: { turn: { id: 'turn-child-1', status: 'completed' } },
              });
            }, 0);
          }
          return true;
        },
      },
    };
    (adapter as any).child = fakeChild;
    (adapter as any).threadId = 'thread-root';

    const response = await adapter.askNativeSubagent('fork this', { approvalMode: 'strict' });

    expect(response.text).toBe('child result');
    expect(response.metadata).toMatchObject({
      nativeSubagent: {
        parentThreadId: 'thread-root',
        threadId: 'thread-child',
        forked: true,
        mode: 'thread-fork',
        effort: 'medium',
      },
    });
    expect(requests.map((request) => request.method)).toEqual(['thread/fork', 'turn/start']);
    expect(requests[1].params.threadId).toBe('thread-child');
    expect(requests[1].params.effort).toBe('medium');
  });
});
