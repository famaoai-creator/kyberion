import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import {
  buildDevinCliBackendFromEnv,
  DevinCliReasoningBackend,
  probeDevinCliAvailability,
} from './devin-cli-reasoning-backend.js';
import { resolveSandboxPolicy, withSandboxPolicy } from './sandbox-policy.js';

const { spawnMock, withWallClockBudgetMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  withWallClockBudgetMock: vi.fn((_opts: unknown, fn: () => Promise<unknown>) => fn()),
}));

interface MockChildProcess extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  kill: (signal: NodeJS.Signals) => void;
  pid: number;
}

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

vi.mock('./delegation-concurrency.js', () => ({
  delegationChildHandleFromChildProcess: (child: MockChildProcess) => ({
    pid: child.pid,
    kill: (signal: NodeJS.Signals) => child.kill(signal),
  }),
  withWallClockBudget: withWallClockBudgetMock,
  DelegationWallClockExceededError: class DelegationWallClockExceededError extends Error {},
}));

function createChild(stdoutText: string, exitCode = 0, stderrText = ''): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn();
  child.pid = 4242;

  setImmediate(() => {
    child.stdout.write(stdoutText);
    child.stdout.end();
    child.stderr.write(stderrText);
    child.stderr.end();
    child.emit('close', exitCode);
  });

  return child;
}

describe('devin-cli-reasoning-backend', () => {
  it('routes Devin CLI environment reads through the governed accessor', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('libs/core/devin-cli-reasoning-backend.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toMatch(/env\.KYBERION_/u);
    expect(source).toContain('getRegisteredEnvText');
  });

  afterEach(() => {
    spawnMock.mockClear();
    withWallClockBudgetMock.mockClear();
  });

  it('returns null when the availability probe fails', () => {
    const backend = buildDevinCliBackendFromEnv(
      { KYBERION_DEVIN_CLI_BIN: 'devin' } as NodeJS.ProcessEnv,
      () => ({ available: false, reason: 'crash on launch' })
    );

    expect(backend).toBeNull();
  });

  it('can report a missing binary as unavailable', () => {
    const probe = probeDevinCliAvailability(
      { KYBERION_DEVIN_CLI_BIN: '__definitely_missing_binary__' } as NodeJS.ProcessEnv,
      { bin: '__definitely_missing_binary__', timeoutMs: 250 }
    );

    expect(probe.available).toBe(false);
    expect(probe.reason).toBeTruthy();
  });

  it('runs headless print mode with the workspace-trust bypass and explorer permission', async () => {
    spawnMock.mockReturnValueOnce(createChild('pong'));

    const backend = new DevinCliReasoningBackend({ bin: 'devin' });
    const result = await backend.prompt('hello');

    expect(result).toBe('pong');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [bin, args] = spawnMock.mock.calls[0];
    expect(bin).toBe('devin');
    expect(args).toEqual(
      expect.arrayContaining([
        '--model',
        'swe',
        '--permission-mode',
        'normal',
        '--respect-workspace-trust',
        'false',
        '-p',
        '--',
      ])
    );
    // Prompt is the last positional arg after `--`.
    expect(args[args.length - 1]).toContain('hello');
    expect(withWallClockBudgetMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'devin' }),
      expect.any(Function)
    );
  });

  it('projects the implementer profile onto devin bypass mode', async () => {
    spawnMock.mockReturnValueOnce(createChild('done'));

    const backend = new DevinCliReasoningBackend({ bin: 'devin' });
    await withSandboxPolicy(
      resolveSandboxPolicy({ provider: 'devin', mode: 'workspace-write', networkAccess: true }),
      async () => {
        await backend.delegateTask('edit something', undefined, { profile: 'implementer' });
      }
    );

    const [, args] = spawnMock.mock.calls[0];
    expect(args).toEqual(
      expect.arrayContaining(['--permission-mode', 'bypass', '--respect-workspace-trust', 'false'])
    );
  });

  it('refuses the planner profile because devin has no headless no-tools mode', async () => {
    const backend = new DevinCliReasoningBackend({ bin: 'devin' });
    await expect(
      backend.delegateTask('plan only', undefined, { profile: 'planner' })
    ).rejects.toThrow(/refused/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects extra args that could override governed flags', () => {
    expect(() => new DevinCliReasoningBackend({ extraArgs: ['--permission-mode'] })).toThrow(
      /governed flag: --permission-mode/
    );
    expect(() => new DevinCliReasoningBackend({ extraArgs: ['--model=x'] })).toThrow(
      /governed flag: --model/
    );
    expect(() => new DevinCliReasoningBackend({ extraArgs: ['-p'] })).toThrow(/governed flag: -p/);
    expect(() => new DevinCliReasoningBackend({ extraArgs: ['-c'] })).toThrow(/governed flag: -c/);
  });

  it('preserves non-governed extra args', async () => {
    spawnMock.mockReturnValueOnce(createChild('ok'));

    const backend = new DevinCliReasoningBackend({ extraArgs: ['--verbose'] });
    await backend.prompt('hello');

    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('--verbose');
  });

  it('rejects empty stdout', async () => {
    spawnMock.mockReturnValueOnce(createChild('   '));

    const backend = new DevinCliReasoningBackend({ bin: 'devin' });
    await expect(backend.prompt('hi')).rejects.toThrow(/no text/);
  });

  it('rejects non-zero exits with stderr evidence', async () => {
    spawnMock.mockReturnValueOnce(createChild('', 1, 'boom'));

    const backend = new DevinCliReasoningBackend({ bin: 'devin' });
    await expect(backend.prompt('hi')).rejects.toThrow(/exited with code 1.*boom/s);
  });

  it('appends a JSON shape hint to structured prompts', async () => {
    spawnMock.mockReturnValueOnce(createChild('{"hypotheses": []}'));

    const backend = new DevinCliReasoningBackend({ bin: 'devin' });
    await backend.divergePersonas({ topic: 't', personas: ['skeptic'] });

    const [, args] = spawnMock.mock.calls[0];
    const prompt = args[args.length - 1] as string;
    expect(prompt).toContain('hypotheses');
    expect(prompt).toContain('proposed_by');
  });

  it('builds a backend when the probe succeeds and honours env overrides', async () => {
    spawnMock.mockReturnValueOnce(createChild('ok'));

    const backend = buildDevinCliBackendFromEnv(
      {
        KYBERION_DEVIN_CLI_BIN: '/custom/devin',
        KYBERION_DEVIN_CLI_MODEL: 'opus',
      } as NodeJS.ProcessEnv,
      () => ({ available: true })
    );
    expect(backend).toBeInstanceOf(DevinCliReasoningBackend);
    expect(backend?.name).toBe('devin-cli');

    await backend?.prompt('hi');
    const [bin, args] = spawnMock.mock.calls[0];
    expect(bin).toBe('/custom/devin');
    expect(args).toEqual(expect.arrayContaining(['--model', 'opus']));
  });
});
