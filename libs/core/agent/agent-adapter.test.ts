import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  AgyAdapter,
  ClaudeAdapter,
  CodexAdapter,
  CodexAppServerAdapter,
  GeminiAdapter,
  GrokAdapter,
} from './agent-adapter.js';
import {
  normalizeCodexAppServerMessage,
  resolveCodexTaskIsolationArgs,
  assertCodexTaskIsolationConfig,
  CODEX_GOVERNED_DISABLED_FEATURES,
} from './agent-codex-app-server-adapter.js';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { currentExecutionScope, runInExecutionScope } from '../foundation/execution-scope.js';
import {
  getReasoningPayloadScope,
  withReasoningPayloadScope,
} from '../reasoning/reasoning-egress-scope.js';
import { pathResolver } from '../path-resolver.js';
import { resolveSandboxPolicy, withSandboxPolicy } from '../shell/sandbox-policy.js';
import { readTextFile } from '../foundation/text.js';
import { safeMkdir, safeReadFile, safeRmSync, safeSymlinkSync } from '../secure-io.js';
import type { TaskToolRuntime } from '../workforce/task-tool-runtime.js';

const codexMocks = vi.hoisted(() => ({
  resolveCodexBinary: vi.fn(),
  safeExecResult: vi.fn(),
  spawnManagedProcess: vi.fn(),
  touchManagedProcess: vi.fn(),
  stopManagedProcess: vi.fn(),
}));

vi.mock('../provider/codex-cli-query.js', () => ({
  resolveCodexBinary: codexMocks.resolveCodexBinary,
}));
vi.mock('../secure-io.js', async () => {
  const actual = await vi.importActual<typeof import('../secure-io.js')>('../secure-io.js');
  return { ...actual, safeExecResult: codexMocks.safeExecResult };
});
vi.mock('../managed-process.js', async () => {
  const actual =
    await vi.importActual<typeof import('../managed-process.js')>('../managed-process.js');
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

  it('ambient AGY read-only policy refuses before the legacy adapter spawns', async () => {
    const policy = resolveSandboxPolicy({
      provider: 'agy',
      mode: 'read-only',
      networkAccess: true,
    });

    const response = await withSandboxPolicy(policy, () => adapter.ask('inspect this'));

    expect(response.stopReason).toBe('error');
    expect(spawn).not.toHaveBeenCalled();
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

describe('ClaudeAdapter tool lockdown', () => {
  it('disables every tool and ignores MCP servers when toolsDisabled is set', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    codexMocks.spawnManagedProcess.mockImplementationOnce(
      (spec: {
        resourceId: string;
        command: string;
        args: string[];
        spawnOptions: SpawnOptions;
      }) => ({
        resourceId: spec.resourceId,
        child: spawn(spec.command, spec.args, spec.spawnOptions),
      })
    );
    vi.mocked(spawn).mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.end(JSON.stringify({ result: 'ok' }));
        child.emit('close', 0, null);
      });
      return child as unknown as ChildProcess;
    });

    const adapter = new ClaudeAdapter({
      toolsDisabled: true,
      allowedTools: ['Read', 'Bash'],
      disallowedTools: ['Write'],
    });
    await adapter.ask('What is our plan?');

    const args = vi.mocked(spawn).mock.calls.at(-1)?.[1] as string[];
    const toolsAt = args.indexOf('--tools');
    expect(args[toolsAt + 1]).toBe('');
    expect(args).toContain('--strict-mcp-config');
    // No CLAUDE.md, user hooks, plugins, slash commands or saved session.
    expect(args).toContain('--setting-sources=');
    expect(args).toContain('--disable-slash-commands');
    expect(args).toContain('--no-session-persistence');
    expect(args).not.toContain('--allowedTools');
    expect(args).not.toContain('--disallowedTools');
  });
});

describe('GeminiWisdomEnhancer path boundary', () => {
  it('revalidates the evolution directory and each lesson before reading', async () => {
    const source = readTextFile(pathResolver.rootResolve('libs/core/agent/agent-adapter.ts'));
    expect(source).toContain('assertSafeRepositoryPath(');
    expect(source).toContain('const wisdomFile = assertSafeRepositoryPath');
    expect(source).toContain('safeLstat(wisdomFile).isFile()');
    expect(source).toContain('[GEMINI_WISDOM_RESOURCE]');
  });
});

describe('CodexAdapter', () => {
  beforeEach(() => vi.clearAllMocks());

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

  it.each(['exec', 'legacy'])(
    'preserves an exact runtime model through the %s adapter factory into CLI argv',
    async (mode) => {
      vi.stubEnv('KYBERION_CODEX_MODE', mode);
      vi.stubEnv('KYBERION_CODEX_MODEL', 'ambient-model-must-not-win');
      try {
        await import('./agent-exec-adapter-providers.js');
        const { createAgentExecAdapter } = await import('./agent-exec-adapter-bridge.js');
        mockSpawnedCli(JSON.stringify({ message: 'selected exact model' }));
        const adapter = await createAgentExecAdapter({
          provider: 'codex',
          modelId: 'requested-exact-model',
        });
        await adapter.boot();
        const response = await adapter.ask('Run the exact target');
        expect(response.text).toBe('selected exact model');
        expect(spawn).toHaveBeenCalledWith(
          'npx',
          [
            'codex',
            'exec',
            '--model',
            'requested-exact-model',
            '--json',
            expect.stringContaining('Run the exact target'),
          ],
          expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] })
        );
        expect(vi.mocked(spawn).mock.calls[0]?.[1]).not.toContain('ambient-model-must-not-win');
        await adapter.shutdown();
      } finally {
        vi.unstubAllEnvs();
      }
    }
  );

  it('fails closed when the Codex JSON response root is not an object', async () => {
    mockSpawnedCli('[]');

    const response = await new CodexAdapter().ask('Say hello');

    expect(response).toEqual(expect.objectContaining({ text: '', stopReason: 'error' }));
  });

  it('projects an ambient read-only policy into the legacy Codex CLI argv', async () => {
    mockSpawnedCli(JSON.stringify({ message: 'codex response' }));
    const policy = resolveSandboxPolicy({
      provider: 'codex',
      mode: 'read-only',
      networkAccess: true,
    });

    await withSandboxPolicy(policy, () => new CodexAdapter().ask('inspect this'));

    expect(spawn).toHaveBeenCalledWith(
      'npx',
      [
        'codex',
        'exec',
        '--sandbox',
        'read-only',
        '--json',
        expect.stringContaining('inspect this'),
      ],
      expect.anything()
    );
  });
});

describe('ClaudeAdapter sandbox context', () => {
  beforeEach(() => vi.clearAllMocks());

  it('overrides a broad legacy permission option under an ambient read-only policy', async () => {
    mockSpawnedCli(JSON.stringify({ result: 'claude response' }));
    const policy = resolveSandboxPolicy({
      provider: 'claude',
      mode: 'read-only',
      networkAccess: true,
    });

    await withSandboxPolicy(policy, () =>
      new ClaudeAdapter({ permissionMode: 'bypassPermissions' }).ask('inspect this')
    );

    const [, args] = vi.mocked(spawn).mock.calls[0] ?? [];
    expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'default']));
    expect(args).not.toContain('bypassPermissions');
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
  it('explicitly disables inherited MCP servers and rejects a surviving enabled server', () => {
    codexMocks.safeExecResult
      .mockReturnValueOnce({
        stdout: JSON.stringify([{ name: 'hostile_inherited', enabled: true }]),
        status: 0,
      })
      .mockReturnValueOnce({
        stdout: JSON.stringify([{ name: 'hostile_inherited', enabled: false }]),
        status: 0,
      });
    const args = resolveCodexTaskIsolationArgs('codex', { CODEX_HOME: '/isolated/home' }, '/task');
    expect(args).toContain('mcp_servers.hostile_inherited.enabled=false');
    expect(args).toContain('features.code_mode.enabled=false');
    expect(args).toContain('code_mode_host');
    expect(CODEX_GOVERNED_DISABLED_FEATURES).not.toContain('code_mode_host');
    expect(args).toContain('code_mode_only_strict_3p_tools');
    expect(args).toContain('features.code_mode.direct_only_tool_namespaces=[]');
    expect(args).toContain('features.code_mode.excluded_tool_namespaces=["functions"]');
    expect(codexMocks.safeExecResult.mock.calls.at(-1)![2]).toMatchObject({
      env: { CODEX_HOME: '/isolated/home' },
      cwd: '/task',
    });
    codexMocks.safeExecResult.mockReturnValue({
      stdout: JSON.stringify([{ name: 'hostile_inherited', enabled: true }]),
      status: 0,
    });
    expect(() => resolveCodexTaskIsolationArgs('codex', {}, '/task')).toThrow('still enables');
    codexMocks.safeExecResult.mockReturnValue({
      stdout: 'invalid sensitive configuration',
      status: 0,
    });
    expect(() => resolveCodexTaskIsolationArgs('codex', {}, '/task')).toThrow('unreadable');
    codexMocks.safeExecResult.mockReturnValue({ stdout: '', stderr: 'private error', status: 1 });
    expect(() => resolveCodexTaskIsolationArgs('codex', {}, '/task')).toThrow('Cannot enumerate');
    vi.clearAllMocks();
  });
  it('checks effective MCP and native settings instead of trusting launch arguments', () => {
    const features = {
      ...Object.fromEntries(CODEX_GOVERNED_DISABLED_FEATURES.map((name) => [name, false])),
      code_mode_host: true,
      code_mode: {
        enabled: false,
        direct_only_tool_namespaces: [],
        excluded_tool_namespaces: ['functions'],
      },
    };
    expect(() =>
      assertCodexTaskIsolationConfig({
        config: {
          web_search: 'disabled',
          features,
          mcp_servers: { inherited: { enabled: false } },
        },
      })
    ).not.toThrow();
    expect(() =>
      assertCodexTaskIsolationConfig({
        config: { web_search: 'disabled', features, mcp_servers: { inherited: { enabled: true } } },
      })
    ).toThrow('not governed-tool-only');
    expect(() =>
      assertCodexTaskIsolationConfig({
        config: { web_search: 'disabled', features: { ...features, shell_tool: true } },
      })
    ).toThrow('not governed-tool-only');
    expect(() =>
      assertCodexTaskIsolationConfig({
        config: {
          web_search: 'disabled',
          features: { ...features, code_mode_only_strict_3p_tools: true },
        },
      })
    ).toThrow('not governed-tool-only');
    expect(() =>
      assertCodexTaskIsolationConfig({
        config: {
          web_search: 'disabled',
          features: { ...features, code_mode_host: false },
        },
      })
    ).toThrow('not governed-tool-only');
    for (const code_mode of [
      { enabled: true, direct_only_tool_namespaces: ['kyberion'], excluded_tool_namespaces: [] },
      {
        enabled: false,
        direct_only_tool_namespaces: ['kyberion'],
        excluded_tool_namespaces: ['functions'],
      },
    ]) {
      expect(() =>
        assertCodexTaskIsolationConfig({
          config: { web_search: 'disabled', features: { ...features, code_mode } },
        })
      ).toThrow('not governed-tool-only');
    }
  });
  it('does not let legacy exec configuration drop a claimed task tool binding', async () => {
    vi.stubEnv('KYBERION_CODEX_MODE', 'exec');
    try {
      await import('./agent-exec-adapter-providers.js');
      const { createAgentExecAdapter } = await import('./agent-exec-adapter-bridge.js');
      const runtime = {
        definitions: [],
        assertCurrent: vi.fn(),
        execute: vi.fn(),
      } as unknown as TaskToolRuntime;
      expect(
        await createAgentExecAdapter({ provider: 'codex', taskToolRuntime: runtime })
      ).toBeInstanceOf(CodexAppServerAdapter);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('boots a verified governed-tool protocol with native features disabled and typed dynamic tools', async () => {
    const requests: Array<{
      method: string;
      params: { capabilities?: { experimentalApi?: boolean } };
    }> = [];
    const child = Object.assign(new EventEmitter(), {
      pid: 43,
      stdin: {
        writable: true,
        write(line: string) {
          const request = JSON.parse(line);
          requests.push(request);
          queueMicrotask(() =>
            child.stdout.write(
              JSON.stringify({
                id: request.id,
                result:
                  request.method === 'initialize'
                    ? {}
                    : request.method === 'config/read'
                      ? {
                          config: {
                            web_search: 'disabled',
                            features: {
                              ...Object.fromEntries(
                                CODEX_GOVERNED_DISABLED_FEATURES.map((name) => [name, false])
                              ),
                              code_mode_host: true,
                              code_mode: {
                                enabled: false,
                                direct_only_tool_namespaces: [],
                                excluded_tool_namespaces: ['functions'],
                              },
                            },
                            mcp_servers: { inherited: { enabled: false } },
                          },
                        }
                      : { thread: { id: 'governed-task-thread' } },
              }) + '\n'
            )
          );
          return true;
        },
      },
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    const runtime = {
      definitions: [
        { name: 'kyberion_task_read_file', description: 'read', inputSchema: { type: 'object' } },
      ],
      assertCurrent: vi.fn(),
      execute: vi.fn(),
    } as unknown as TaskToolRuntime;
    codexMocks.resolveCodexBinary.mockReturnValue('codex-fixture');
    codexMocks.safeExecResult.mockImplementation((_binary, args) => ({
      stdout:
        args[0] === '--version'
          ? 'codex-cli 0.164.0'
          : JSON.stringify([
              {
                name: 'inherited',
                enabled: args.includes('mcp_servers.inherited.enabled=false') ? false : true,
              },
            ]),
      stderr: '',
      status: 0,
    }));
    codexMocks.spawnManagedProcess.mockReturnValue({ child });
    const adapter = new CodexAppServerAdapter({
      cwd: 'fixture/project',
      model: 'codex',
      timeoutMs: 1000,
      taskToolRuntime: runtime,
      sandboxMode: 'read-only',
      networkAccess: false,
    });
    await adapter.boot();
    expect(adapter.getRuntimeInfo()).toMatchObject({
      governedTaskToolCount: 1,
      governedTaskToolNamespace: 'kyberion',
    });
    const argv = codexMocks.spawnManagedProcess.mock.calls.at(-1)![0].args;
    expect(argv).toEqual(
      expect.arrayContaining([
        '--disable',
        'shell_tool',
        'unified_exec',
        '-c',
        'mcp_servers.inherited.enabled=false',
      ])
    );
    expect(argv).not.toContain('--ignore-user-config');
    expect(
      requests.find((request) => request.method === 'initialize')?.params.capabilities
        ?.experimentalApi
    ).toBe(true);
    expect(requests.find((request) => request.method === 'thread/start')?.params).toMatchObject({
      sandbox: 'read-only',
      dynamicTools: [
        {
          name: 'kyberion',
          type: 'namespace',
          tools: [{ name: '_task_read_file', type: 'function' }],
        },
      ],
    });
    expect(
      requests.find((request) => request.method === 'thread/start')?.params.model
    ).toBeUndefined();
    await adapter.shutdown();
    vi.clearAllMocks();
  });
  it('executes only tools bound to the claimed task and refuses native grants even in relaxed mode', async () => {
    const runtime = {
      definitions: [
        { name: 'kyberion_task_read_file', description: 'read', inputSchema: { type: 'object' } },
      ],
      assertCurrent: vi.fn(),
      execute: vi.fn(async () => ({ text: 'safe result' })),
    } as unknown as TaskToolRuntime;
    const adapter = new CodexAppServerAdapter({
      taskToolRuntime: runtime,
      approvalMode: 'relaxed',
    });
    const responses: Array<{ result: Record<string, unknown> }> = [];
    const harness = adapter as unknown as {
      activeTurnContext: ReturnType<typeof AsyncLocalStorage.snapshot>;
      child: unknown;
      handleServerRequest(request: {
        id: number;
        method: string;
        params: Record<string, unknown>;
      }): Promise<void>;
    };
    harness.activeTurnContext = AsyncLocalStorage.snapshot();
    harness.child = {
      stdin: { writable: true, write: (line: string) => responses.push(JSON.parse(line)) },
    };
    await harness.handleServerRequest({
      id: 1,
      method: 'item/tool/call',
      params: {
        namespace: 'kyberion',
        tool: '_task_read_file',
        arguments: { path: 'libs/a.ts' },
      },
    });
    expect(runtime.execute).toHaveBeenCalledWith({
      name: 'kyberion_task_read_file',
      arguments: { path: 'libs/a.ts' },
    });
    expect(responses[0].result).toMatchObject({ success: true });
    await expect(
      harness.handleServerRequest({
        id: 2,
        method: 'item/tool/call',
        params: { namespace: 'kyberion', tool: 'unregistered', arguments: {} },
      })
    ).rejects.toThrow('not installed uniquely');
    for (const namespace of [undefined, 'functions', 'foreign']) {
      await expect(
        harness.handleServerRequest({
          id: 21,
          method: 'item/tool/call',
          params: { namespace, tool: '_task_read_file', arguments: {} },
        })
      ).rejects.toThrow('does not belong');
    }
    expect(runtime.execute).toHaveBeenCalledTimes(1);
    for (const tool of ['kyberion_task_read_file', 'task_read_file']) {
      await expect(
        harness.handleServerRequest({
          id: 22,
          method: 'item/tool/call',
          params: { namespace: 'kyberion', tool, arguments: {} },
        })
      ).rejects.toThrow('not installed uniquely');
    }
    runtime.definitions.push({
      name: '_task_read_file',
      description: 'collision',
      inputSchema: { type: 'object' },
    });
    await expect(
      harness.handleServerRequest({
        id: 23,
        method: 'item/tool/call',
        params: { namespace: 'kyberion', tool: '_task_read_file', arguments: {} },
      })
    ).rejects.toThrow('not installed uniquely');
    runtime.definitions.pop();
    expect(runtime.execute).toHaveBeenCalledTimes(1);
    await harness.handleServerRequest({
      id: 3,
      method: 'item/commandExecution/requestApproval',
      params: { command: 'cat knowledge/personal/private.txt' },
    });
    await harness.handleServerRequest({
      id: 4,
      method: 'item/fileChange/requestApproval',
      params: {},
    });
    await harness.handleServerRequest({
      id: 5,
      method: 'item/permissions/requestApproval',
      params: { permissions: { network: true } },
    });
    expect(responses[1].result.decision).toBe('decline');
    expect(responses[2].result.decision).toBe('decline');
    expect(responses[3].result.permissions).toEqual({});
    expect(runtime.execute).toHaveBeenCalledTimes(1);
  });

  it('does not execute a dynamic call after lease expiry', async () => {
    const runtime = {
      definitions: [{ name: 'bound', description: 'bound', inputSchema: { type: 'object' } }],
      assertCurrent: () => {
        throw new Error('lease expired');
      },
      execute: vi.fn(),
    } as unknown as TaskToolRuntime;
    const adapter = new CodexAppServerAdapter({ taskToolRuntime: runtime });
    Object.assign(adapter, { activeTurnContext: AsyncLocalStorage.snapshot() });
    await expect(
      (
        adapter as unknown as {
          handleServerRequest(request: {
            id: number;
            method: string;
            params: Record<string, unknown>;
          }): Promise<void>;
        }
      ).handleServerRequest({
        id: 1,
        method: 'item/tool/call',
        params: { namespace: 'kyberion', tool: 'bound', arguments: {} },
      })
    ).rejects.toThrow('lease expired');
    expect(runtime.execute).not.toHaveBeenCalled();
  });

  it('replays the asking operator scope for early dynamic tools emitted by a different boot resource', async () => {
    const boot = runInExecutionScope(
      { tenantBound: false, executionIdentity: { taskId: 'boot-a' } },
      () => new AsyncResource('codex-boot-stdout')
    );
    const observed: unknown[] = [];
    const runtime = {
      definitions: [{ name: 'bound', description: 'bound', inputSchema: { type: 'object' } }],
      assertCurrent: vi.fn(),
      execute: vi.fn(async () => {
        observed.push({ execution: currentExecutionScope(), payload: getReasoningPayloadScope() });
        return { ok: true };
      }),
    } as unknown as TaskToolRuntime;
    const adapter = new CodexAppServerAdapter({ taskToolRuntime: runtime, timeoutMs: 1000 });
    const stdout = new PassThrough();
    const harness = adapter as unknown as {
      child: unknown;
      threadId: string;
      activeTurnContext: unknown;
      handleStdout(chunk: Buffer): void;
    };
    stdout.on('data', (chunk: Buffer) => harness.handleStdout(chunk));
    const emit = (message: unknown) =>
      boot.runInAsyncScope(() => stdout.write(JSON.stringify(message) + '\n'));
    harness.threadId = 'thread-b';
    harness.child = {
      stdin: {
        writable: true,
        write(line: string) {
          const request = JSON.parse(line);
          if (request.method === 'turn/start') {
            queueMicrotask(() => {
              // The tool arrives before the turn/start response or turn/started event.
              emit({
                id: 91,
                method: 'item/tool/call',
                params: {
                  threadId: 'thread-b',
                  turnId: 'turn-b',
                  namespace: 'kyberion',
                  tool: 'bound',
                  arguments: {},
                },
              });
              emit({ id: request.id, result: { turn: { id: 'turn-b' } } });
            });
          } else if (request.id === 91) {
            emit({
              method: 'turn/completed',
              params: {
                turn: { id: 'turn-b', status: 'completed' },
              },
            });
          }
          return true;
        },
      },
    };
    await runInExecutionScope({ tenantBound: false, executionIdentity: { taskId: 'ask-b' } }, () =>
      withReasoningPayloadScope(
        { tier: 'personal', tenant_slug: 'ask-b', external_egress: 'deny' },
        () => adapter.ask('use bound tool')
      )
    );
    expect(observed).toEqual([
      {
        execution: expect.objectContaining({ tenantBound: false }),
        payload: expect.objectContaining({
          tier: 'personal',
          tenant_slug: 'ask-b',
          external_egress: 'deny',
        }),
      },
    ]);
    expect(harness.activeTurnContext).toBeNull();
    emit({
      id: 92,
      method: 'item/tool/call',
      params: { namespace: 'kyberion', tool: 'bound', arguments: {} },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(runtime.execute).toHaveBeenCalledTimes(1);
    boot.emitDestroy();
  });

  it('normalizes JSON-RPC response and request envelopes', () => {
    expect(
      normalizeCodexAppServerMessage({
        jsonrpc: '2.0',
        id: 1,
        result: { thread: { id: 'thread-1' } },
      })
    ).toEqual({ jsonrpc: '2.0', id: 1, result: { thread: { id: 'thread-1' } } });
    expect(
      normalizeCodexAppServerMessage({
        jsonrpc: '2.0',
        id: 'req-1',
        method: 'turn/start',
        params: {},
      })
    ).toEqual({ jsonrpc: '2.0', id: 'req-1', method: 'turn/start', params: {} });
  });

  it('rejects malformed JSON-RPC envelopes before dispatch', () => {
    expect(normalizeCodexAppServerMessage(null)).toBeNull();
    expect(normalizeCodexAppServerMessage([])).toBeNull();
    expect(normalizeCodexAppServerMessage({ id: 1 })).toBeNull();
    expect(normalizeCodexAppServerMessage({ id: 1, result: {}, error: {} })).toBeNull();
    expect(normalizeCodexAppServerMessage({ method: 'turn/start', params: [] })).toBeNull();
    expect(normalizeCodexAppServerMessage({ jsonrpc: '1.0', method: 'turn/start' })).toBeNull();
    expect(
      normalizeCodexAppServerMessage({ method: 'turn/start', error: { code: 'bad' } })
    ).toBeNull();
  });

  it('rejects symlinked read-only paths and cwd before approval or spawn', async () => {
    const suffix = `codex-app-server-scope-${process.pid}`;
    const target = pathResolver.sharedTmp(`${suffix}-target`);
    const link = pathResolver.sharedTmp(`${suffix}-link`);
    safeMkdir(target);
    safeSymlinkSync(target, link, 'dir');
    try {
      const adapter = new CodexAppServerAdapter({ cwd: link, timeoutMs: 1000 });
      expect((adapter as any).isPathAllowed(`${link}/input.txt`, pathResolver.rootDir())).toBe(
        false
      );
      await expect(adapter.boot()).rejects.toThrow('[RESOURCE_PATH_SYMLINK]');
      expect(codexMocks.resolveCodexBinary).not.toHaveBeenCalled();
    } finally {
      safeRmSync(link, { recursive: true, force: true });
      safeRmSync(target, { recursive: true, force: true });
    }
  });

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

  it.each(['codex', 'codex-cli', 'default', 'auto', ' CoDeX ', ' AUTO ', 'exact-account-model'])(
    'projects subagent turns and resolves native default model alias %s',
    async (model) => {
      const adapter = new CodexAppServerAdapter({ timeoutMs: 1000, model });
      const internals = adapter as unknown as {
        child: unknown;
        threadId: string | null;
        handleMessage(message: Record<string, unknown>): void;
      };
      const requests: Array<{
        id: number | string;
        method: string;
        params: Record<string, unknown>;
      }> = [];
      const fakeChild = {
        stdin: {
          writable: true,
          write(payload: string) {
            const request = JSON.parse(payload) as (typeof requests)[number];
            requests.push(request);
            if (request.method !== 'turn/start') return true;
            setTimeout(() => {
              internals.handleMessage({
                id: request.id,
                result: { turn: { id: 'turn-native-1' } },
              });
            }, 0);
            setTimeout(() => {
              internals.handleMessage({
                method: 'item/agentMessage/delta',
                params: {
                  threadId: 'thread-root',
                  turnId: 'turn-native-1',
                  delta: 'native result',
                },
              });
              internals.handleMessage({
                method: 'turn/completed',
                params: { turn: { id: 'turn-native-1', status: 'completed' } },
              });
            }, 1);
            return true;
          },
        },
      };
      internals.child = fakeChild;
      internals.threadId = 'thread-root';

      const response = await adapter.ask('delegate this', { subagent: true });

      expect(response.text).toBe('native result');
      const turnStart = requests.find((request) => request.method === 'turn/start');
      expect(turnStart?.params.threadId).toBe('thread-root');
      expect(turnStart?.params.model).toBe(model === 'exact-account-model' ? model : undefined);
      expect(turnStart?.params.effort).toBe('medium');
      expect(requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
    }
  );

  it('retains a native failed-turn provider cause instead of an opaque empty result', async () => {
    const adapter = new CodexAppServerAdapter({ timeoutMs: 1000, model: 'auto' });
    const internals = adapter as unknown as {
      child: unknown;
      threadId: string | null;
      handleMessage(message: Record<string, unknown>): void;
    };
    const requests: Array<{
      id: number | string;
      method: string;
      params: Record<string, unknown>;
    }> = [];
    internals.child = {
      stdin: {
        writable: true,
        write(payload: string) {
          const request = JSON.parse(payload) as (typeof requests)[number];
          requests.push(request);
          if (request.method === 'turn/start') {
            queueMicrotask(() => {
              internals.handleMessage({
                method: 'turn/completed',
                params: {
                  turn: {
                    id: 'failed-provider-turn',
                    status: 'failed',
                    error: { message: 'model_not_found: selected account model unavailable' },
                  },
                },
              });
              internals.handleMessage({
                id: request.id,
                result: { turn: { id: 'failed-provider-turn' } },
              });
            });
          }
          return true;
        },
      },
    };
    internals.threadId = 'thread-root';
    const result = await adapter.ask('run once');
    expect(result).toMatchObject({
      stopReason: 'error',
      text: 'model_not_found: selected account model unavailable',
    });
    expect(requests.filter((request) => request.method === 'turn/start')).toHaveLength(1);
  });

  it('interrupts the active native turn on cancellation without restarting the app-server', async () => {
    const adapter = new CodexAppServerAdapter({ timeoutMs: 1000 });
    const internals = adapter as unknown as {
      child: unknown;
      threadId: string | null;
      handleMessage(message: Record<string, unknown>): void;
    };
    const requests: Array<{
      id: number | string;
      method: string;
      params: Record<string, unknown>;
    }> = [];
    const fakeChild = {
      stdin: {
        writable: true,
        write(payload: string) {
          const request = JSON.parse(payload) as (typeof requests)[number];
          requests.push(request);
          if (request.method === 'turn/start') {
            setTimeout(() => {
              internals.handleMessage({
                id: request.id,
                result: { turn: { id: 'turn-cancel-1' } },
              });
            }, 0);
          } else if (request.method === 'turn/interrupt') {
            setTimeout(() => {
              internals.handleMessage({ id: request.id, result: {} });
            }, 0);
          }
          return true;
        },
      },
    };
    internals.child = fakeChild;
    internals.threadId = 'thread-root';
    const controller = new AbortController();
    const pending = adapter.ask('cancel this', { subagent: true, signal: controller.signal });

    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();

    await expect(pending).rejects.toThrow('cancelled');
    expect(requests.map((request) => request.method)).toEqual(['turn/start', 'turn/interrupt']);
  });

  it('still cancels the turn when the abort lands before turn/start resolves', async () => {
    const adapter = new CodexAppServerAdapter({ timeoutMs: 1000 });
    type JsonRpcRequest = { id: number | string; method: string };
    type AdapterInternals = {
      child: unknown;
      threadId: string | null;
      handleMessage(message: Record<string, unknown>): void;
    };
    const internals = adapter as unknown as AdapterInternals;
    const requests: JsonRpcRequest[] = [];
    let resolveStartWritten: () => void = () => undefined;
    const turnStartWritten = new Promise<void>((resolve) => {
      resolveStartWritten = resolve;
    });
    const fakeChild = {
      stdin: {
        writable: true,
        write(payload: string): boolean {
          const request = JSON.parse(payload) as JsonRpcRequest;
          requests.push(request);
          if (request.method === 'turn/start') {
            resolveStartWritten();
          } else if (request.method === 'turn/interrupt') {
            internals.handleMessage({ id: request.id, result: {} });
          }
          return true;
        },
      },
    };
    internals.child = fakeChild;
    internals.threadId = 'thread-root';
    const controller = new AbortController();
    const pending = adapter.ask('cancel this', { subagent: true, signal: controller.signal });

    await turnStartWritten;
    controller.abort();
    const turnStart = requests.find((request) => request.method === 'turn/start');
    if (!turnStart) throw new Error('turn/start was not sent');
    internals.handleMessage({
      id: turnStart.id,
      result: { turn: { id: 'turn-cancel-late' } },
    });

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

describe('native transport credential scope fence', () => {
  it.each([
    ['codex-app-server', () => new CodexAppServerAdapter()],
    ['codex-exec', () => new CodexAdapter()],
    ['gemini-acp', () => new GeminiAdapter()],
    ['grok-acp', () => new GrokAdapter()],
    ['agy', () => new AgyAdapter()],
    ['claude-legacy', () => new ClaudeAdapter()],
  ] as const)(
    'rejects %s boot and cached ask in a tenant before any process or request',
    async (_name, create) => {
      codexMocks.spawnManagedProcess.mockClear();
      codexMocks.safeExecResult.mockClear();
      const operatorAdapter = create();
      await runInExecutionScope({ tenantBound: true, tenantSlug: 'native-fixture' }, async () => {
        await expect(operatorAdapter.boot()).rejects.toThrow(
          /CREDENTIAL_(?:OWNER_DENIED|NATIVE_UNSUPPORTED)/
        );
        await expect(operatorAdapter.ask('must not send')).rejects.toThrow(
          /CREDENTIAL_(?:OWNER_DENIED|NATIVE_UNSUPPORTED)/
        );
        const tenantAdapter = create();
        await expect(tenantAdapter.boot()).rejects.toThrow('CREDENTIAL_NATIVE_UNSUPPORTED');
        await expect(tenantAdapter.ask('must not send')).rejects.toThrow(
          'CREDENTIAL_NATIVE_UNSUPPORTED'
        );
        expect(codexMocks.spawnManagedProcess).not.toHaveBeenCalled();
        expect(codexMocks.safeExecResult).not.toHaveBeenCalled();
      });
    }
  );
});

describe('cached native request ownership', () => {
  it('rejects a cached app-server across tasks of the same tenant before stdin, refresh or diagnostics', async () => {
    const adapter = runInExecutionScope(
      {
        tenantBound: true,
        tenantSlug: 'native-fixture',
        assumedRole: 'mission_controller',
        executionIdentity: { missionId: 'mission-a', taskId: 'task-a' },
      },
      () => new CodexAppServerAdapter()
    );
    const write = vi.fn();
    Object.assign(adapter, {
      threadId: 'cached-thread',
      child: { stdin: { writable: true, write } },
    });
    await runInExecutionScope(
      {
        tenantBound: true,
        tenantSlug: 'native-fixture',
        assumedRole: 'mission_controller',
        executionIdentity: { missionId: 'mission-a', taskId: 'task-b' },
      },
      async () => {
        await expect(adapter.ask('must not send')).rejects.toThrow('CREDENTIAL_OWNER_DENIED');
        await expect(adapter.refreshContext()).rejects.toThrow('CREDENTIAL_OWNER_DENIED');
        await expect(adapter.shutdown()).rejects.toThrow('CREDENTIAL_OWNER_DENIED');
        expect(() => adapter.getRuntimeInfo()).toThrow('CREDENTIAL_OWNER_DENIED');
        expect(() => adapter.getLog()).toThrow('CREDENTIAL_OWNER_DENIED');
      }
    );
    expect(write).not.toHaveBeenCalled();
  });
});
