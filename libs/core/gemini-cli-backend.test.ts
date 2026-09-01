import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { GeminiCliBackend } from './gemini-cli-backend.js';
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
