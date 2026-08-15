import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgyAdapter, ClaudeAdapter, CodexAdapter, CodexAppServerAdapter } from './agent-adapter.js';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const codexMocks = vi.hoisted(() => ({
  resolveCodexBinary: vi.fn(),
  safeExecResult: vi.fn(),
  spawnManagedProcess: vi.fn(),
  touchManagedProcess: vi.fn(),
  stopManagedProcess: vi.fn(),
}));

vi.mock('./codex-cli-query.js', () => ({ resolveCodexBinary: codexMocks.resolveCodexBinary }));
vi.mock('./secure-io.js', async () => {
  const actual = await vi.importActual<typeof import('./secure-io.js')>('./secure-io.js');
  return { ...actual, safeExecResult: codexMocks.safeExecResult };
});
vi.mock('./managed-process.js', async () => {
  const actual =
    await vi.importActual<typeof import('./managed-process.js')>('./managed-process.js');
  return {
    ...actual,
    spawnManagedProcess: codexMocks.spawnManagedProcess,
    touchManagedProcess: codexMocks.touchManagedProcess,
    stopManagedProcess: codexMocks.stopManagedProcess,
  };
});

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

function mockSpawnedCli(stdout = 'Response', status = 0, stderr = '') {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  codexMocks.spawnManagedProcess.mockImplementationOnce((spec: any) => ({
    resourceId: spec.resourceId,
    child: spawn(spec.command, spec.args, spec.spawnOptions),
  }));
  vi.mocked(spawn).mockImplementationOnce(() => {
    queueMicrotask(() => {
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      child.emit('close', status, null);
    });
    return child as any;
  });
}

describe('AgyAdapter', () => {
  let adapter: AgyAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new AgyAdapter({ bin: 'agy' });
  });

  it('correctly executes a basic stateless single-prompt run', async () => {
    mockSpawnedCli('Hello World');

    const response = await adapter.ask('Say hello');
    expect(response.text).toBe('Hello World');
    expect(response.stopReason).toBe('completed');

    expect(spawn).toHaveBeenCalledWith(
      'agy',
      ['-p', 'Say hello', '--dangerously-skip-permissions'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
    );
  });

  it('correctly passes conversationId for session persistence', async () => {
    mockSpawnedCli();

    await adapter.ask('Continuing...', { conversationId: 'session-123' });

    expect(spawn).toHaveBeenCalledWith(
      'agy',
      ['-p', 'Continuing...', '--dangerously-skip-permissions', '--conversation', 'session-123'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
    );

    const runtimeInfo = adapter.getRuntimeInfo();
    expect(runtimeInfo.stateless).toBe(false);
    expect(runtimeInfo.sessionId).toBe('session-123');
  });

  it('correctly passes addDirs to mount dynamic directories', async () => {
    mockSpawnedCli();

    await adapter.ask('Check files', { addDirs: ['/path/to/dir1', '/path/to/dir2'] });

    expect(spawn).toHaveBeenCalledWith(
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
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
    );
  });

  it('correctly passes sandbox flag', async () => {
    mockSpawnedCli();

    await adapter.ask('Risky run', { sandbox: true });

    expect(spawn).toHaveBeenCalledWith(
      'agy',
      ['-p', 'Risky run', '--dangerously-skip-permissions', '--sandbox'],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
    );
  });

  it('correctly executes in interactive mode with inherited stdio', async () => {
    mockSpawnedCli('');

    const response = await adapter.ask('Interactive prompt', { interactive: true });
    expect(response.text).toBe('Interactive session completed.');
    expect(response.stopReason).toBe('completed');

    expect(spawn).toHaveBeenCalledWith(
      'agy',
      ['-i', 'Interactive prompt', '--dangerously-skip-permissions'],
      expect.objectContaining({ stdio: 'inherit' })
    );
  });

  it('passes effort to the Claude CLI when configured', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    codexMocks.spawnManagedProcess.mockImplementationOnce((spec: any) => ({
      resourceId: spec.resourceId,
      child: spawn(spec.command, spec.args, spec.spawnOptions),
    }));
    vi.mocked(spawn).mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.end(JSON.stringify({ result: 'ok' }));
        child.emit('close', 0, null);
      });
      return child as any;
    });

    const adapter = new ClaudeAdapter({
      model: 'sonnet',
      effort: 'high',
      systemPrompt: 'system',
      allowedTools: ['Read', 'Bash'],
    });

    const response = await adapter.ask('Do the thing');
    expect(response.text).toBe('ok');

    expect(spawn).toHaveBeenCalledWith(
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
        '--tools',
        'Read,Bash',
        '--allowedTools',
        'Read',
        'Bash',
      ],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
    );
  });
});

describe('CodexAdapter', () => {
  it('runs the legacy Codex CLI through an asynchronous child process', async () => {
    mockSpawnedCli(JSON.stringify({ message: 'codex response' }));

    const response = await new CodexAdapter().ask('Say hello');

    expect(response.text).toBe('codex response');
    expect(response.stopReason).toBe('completed');
    expect(spawn).toHaveBeenCalledWith(
      'npx',
      ['codex', 'exec', '--json', expect.stringContaining('Say hello')],
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
    );
  });
});

describe('ClaudeAdapter tool restrictions', () => {
  it('keeps Bash available when code-actuator is allowed but system-actuator is denied', () => {
    const restrictions = ClaudeAdapter.resolveToolRestrictions(
      ['file-actuator', 'code-actuator'],
      ['system-actuator']
    );

    expect(restrictions.allowedTools).toContain('Bash');
    expect(restrictions.disallowedTools).not.toContain('Bash');
  });
});

describe('CodexAppServerAdapter', () => {
  it('boots with the injected resolved binary and preserves startup diagnostics', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      stdin: {
        writable: true,
        write(payload: string) {
          const request = JSON.parse(payload);
          const result =
            request.method === 'initialize'
              ? { capabilities: {} }
              : { thread: { id: 'thread-boot' } };
          setTimeout(
            () => child.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`),
            0
          );
          return true;
        },
      },
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    codexMocks.resolveCodexBinary.mockReturnValue('codex-from-fixture');
    codexMocks.safeExecResult.mockReturnValue({ stdout: 'codex 9.9.9\n', stderr: '', status: 0 });
    codexMocks.spawnManagedProcess.mockReturnValue({ child });
    const adapter = new CodexAppServerAdapter({ cwd: 'fixture/project', timeoutMs: 1000 });

    await adapter.boot();
    child.stderr.write('codex_models_manager: cache unavailable');
    child.stderr.write('unexpected startup detail');

    expect(codexMocks.spawnManagedProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'codex-from-fixture',
        args: ['app-server', '--listen', 'stdio://'],
      })
    );
    expect(adapter.getRuntimeInfo()).toMatchObject({
      codexBinary: 'codex-from-fixture',
      codexVersion: 'codex 9.9.9',
      threadId: 'thread-boot',
    });
    expect(stderrWrite.mock.calls.map(([line]) => String(line))).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          '[UAA_CODEX_MODEL_CACHE_WARN] codex_models_manager: cache unavailable'
        ),
        expect.stringContaining('[UAA_CODEX_ERR] unexpected startup detail'),
      ])
    );
    expect(stderrWrite.mock.calls.map(([line]) => String(line)).join(' ')).not.toContain(
      '[UAA_CODEX_ERR] codex_models_manager'
    );
    stderrWrite.mockRestore();
  });

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
