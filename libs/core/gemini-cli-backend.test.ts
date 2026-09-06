import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import { buildGeminiCliBackendFromEnv, GeminiCliBackend } from './gemini-cli-backend.js';
import { resolveSandboxPolicy, withSandboxPolicy } from './sandbox-policy.js';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

function createChild(stdoutText: string, exitCode = 0): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn();

  queueMicrotask(() => {
    child.stdout.write(stdoutText);
    child.stdout.end();
    child.stderr.end();
    child.emit('close', exitCode);
  });

  return child;
}

describe('gemini-cli-backend sandbox projection', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it('projects active read-only policy instead of delegation YOLO mode', async () => {
    spawnMock.mockReturnValue(createChild('{"response":"ok"}'));
    const backend = new GeminiCliBackend({
      model: 'gemini-test-model',
      extraArgs: ['-y', '--approval-mode', 'yolo', '--sandbox=false', '--debug'],
    });
    const policy = resolveSandboxPolicy({
      provider: 'gemini',
      mode: 'read-only',
      networkAccess: true,
    });

    await withSandboxPolicy(policy, () => backend.delegateTask('inspect the thing'));

    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args).toEqual(
      expect.arrayContaining([
        '--sandbox',
        '--approval-mode',
        'plan',
        '--model',
        'gemini-test-model',
      ])
    );
    expect(args).not.toContain('-y');
    expect(args).not.toContain('--sandbox=false');
    expect(args).toContain('--debug');
  });

  it('routes Gemini CLI environment reads through the governed accessor', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('libs/core/gemini-cli-backend.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toMatch(/env\.KYBERION_/u);
    expect(source).toContain('getRegisteredEnvText');
  });

  it('uses an injected environment when constructing the CLI backend', async () => {
    spawnMock.mockReturnValue(createChild('{"response":"ok"}'));
    const backend = buildGeminiCliBackendFromEnv({
      KYBERION_GEMINI_CLI_BIN: 'gemini-test',
      KYBERION_GEMINI_CLI_MODEL: 'gemini-model',
      KYBERION_GEMINI_CLI_TIMEOUT: '2500',
    });

    await backend?.prompt('inspect the thing');

    expect(spawnMock).toHaveBeenCalledWith(
      'gemini-test',
      expect.arrayContaining(['--model', 'gemini-model']),
      expect.anything()
    );
  });

  it('keeps the historical YOLO delegation default without an active policy', async () => {
    spawnMock.mockReturnValue(createChild('{"response":"ok"}'));
    const backend = new GeminiCliBackend({ model: 'gemini-test-model' });

    await backend.delegateTask('inspect the thing');

    const args = spawnMock.mock.calls[0]?.[1] as string[];
    expect(args).toContain('-y');
    expect(args).not.toContain('--sandbox');
  });

  it('passes only Gemini credentials to the child process', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'gemini-secret');
    vi.stubEnv('ANTHROPIC_API_KEY', 'claude-secret');
    vi.stubEnv('OPENAI_API_KEY', 'openai-secret');
    spawnMock.mockReturnValue(createChild('{"response":"ok"}'));

    const backend = new GeminiCliBackend({ model: 'gemini-test-model' });
    await backend.prompt('inspect the thing');

    const childEnv = spawnMock.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;
    expect(childEnv.GEMINI_API_KEY).toBe('gemini-secret');
    expect(childEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(childEnv.OPENAI_API_KEY).toBeUndefined();
  });
});
