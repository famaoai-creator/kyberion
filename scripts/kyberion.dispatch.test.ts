import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawnManagedProcess: vi.fn(),
  safeExecResultAsync: vi.fn(),
  assertGovernedExec: vi.fn(),
}));

vi.mock('@agent/core/managed-process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/managed-process')>()),
  spawnManagedProcess: mocks.spawnManagedProcess,
}));

vi.mock('@agent/core/secure-io', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/secure-io')>()),
  safeExecResultAsync: mocks.safeExecResultAsync,
  assertGovernedExec: mocks.assertGovernedExec,
}));

import { main, pnpmExecutable, runStreamingScriptCommand } from './kyberion.js';
import { loadCliManifest } from './check_cli_manifest.js';

function fakeChild(exitCode: number | null, signal: NodeJS.Signals | null = null) {
  const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
  setTimeout(() => child.emit('exit', exitCode, signal), 0);
  return child;
}

describe('kyberion script-command dispatch', () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.safeExecResultAsync.mockResolvedValue({ stdout: 'buffered\n', stderr: '', status: 0 });
  });

  it('passes existing GitHub bindings only to the registered PR publisher', async () => {
    vi.stubEnv('GH_TOKEN', 'fake-gh-binding');
    vi.stubEnv('GITHUB_TOKEN', 'fake-github-binding');
    vi.stubEnv('ANTHROPIC_API_KEY', 'fake-unrelated-binding');
    mocks.spawnManagedProcess.mockImplementation(() => ({ child: fakeChild(0) }));
    await main(['pr', 'create', '--title', 'fix(pr): preserve auth'], () => undefined);
    const publisherEnv = mocks.spawnManagedProcess.mock.calls[0][0].spawnOptions.env;
    expect(publisherEnv.GH_TOKEN).toBe('fake-gh-binding');
    expect(publisherEnv.GITHUB_TOKEN).toBe('fake-github-binding');
    expect(publisherEnv.ANTHROPIC_API_KEY).toBeUndefined();
    await main(['tui'], () => undefined);
    const otherEnv = mocks.spawnManagedProcess.mock.calls[1][0].spawnOptions.env;
    expect(otherEnv.GH_TOKEN).toBeUndefined();
    expect(otherEnv.GITHUB_TOKEN).toBeUndefined();
    await main(['customer', 'list'], () => undefined);
    expect(mocks.safeExecResultAsync.mock.calls[0][2].env).toEqual({});
  });

  it('CU-02: runs interactive / long-running commands on the operator terminal without a timeout', async () => {
    mocks.spawnManagedProcess.mockImplementation(() => ({ child: fakeChild(0) }));
    await main(['tui'], () => undefined);
    expect(mocks.safeExecResultAsync).not.toHaveBeenCalled();
    expect(mocks.spawnManagedProcess).toHaveBeenCalledTimes(1);
    const spec = mocks.spawnManagedProcess.mock.calls[0]?.[0];
    expect(spec.command).toBe('pnpm');
    expect(spec.args).toEqual(['run', 'tui']);
    expect(spec.spawnOptions.stdio).toBe('inherit');
    expect(spec).not.toHaveProperty('timeoutMs');
  });

  it('CU-02: propagates a streamed child failure as the exit code', async () => {
    mocks.spawnManagedProcess.mockImplementation(() => ({ child: fakeChild(3) }));
    await expect(main(['build'], () => undefined)).rejects.toMatchObject({ code: 3 });
  });

  it('CU-02: marks every terminal / server / daemon command in the registry', () => {
    const scripts = loadCliManifest().script_commands ?? [];
    const streamed = new Set(
      scripts
        .filter((command) => command.interactive || command.long_running)
        .map((command) => command.command)
    );
    for (const command of [
      'tui default',
      'office default',
      'scheduler default',
      'dashboard default',
      'pads server',
      'mcp server',
      'telegram bridge',
      'agent-runtime daemon',
      'onboarding default',
      'build default',
    ]) {
      expect(streamed, command).toContain(command);
    }
  });

  it('keeps short commands buffered through the printer', async () => {
    const output: unknown[] = [];
    await main(['customer', 'list'], (value) => output.push(value));
    expect(mocks.spawnManagedProcess).not.toHaveBeenCalled();
    expect(output).toEqual(['buffered']);
  });

  it('CU-01: answers --help from the registry for targets without a guarded help', async () => {
    const output: unknown[] = [];
    await main(['backup', '--help'], (value) => output.push(value));
    expect(mocks.safeExecResultAsync).not.toHaveBeenCalled();
    expect(mocks.spawnManagedProcess).not.toHaveBeenCalled();
    expect(String(output[0])).toContain('pnpm kyberion backup');
  });

  it('CU-01: forwards --help to targets that guard it themselves', async () => {
    mocks.spawnManagedProcess.mockImplementation(() => ({ child: fakeChild(0) }));
    await main(['pr', 'create', '--help'], () => undefined);
    const spec = mocks.spawnManagedProcess.mock.calls[0]?.[0];
    expect(spec.args.at(-1)).toBe('--help');
  });

  it('CU-04: rejects unknown commands with a suggestion and never spawns', async () => {
    await expect(main(['doctr'], () => undefined)).rejects.toThrow(/kyberion doctor/u);
    expect(mocks.safeExecResultAsync).not.toHaveBeenCalled();
    expect(mocks.spawnManagedProcess).not.toHaveBeenCalled();
  });

  it('CU-02: re-raises a signal that killed the streamed child instead of mapping it to exit 1', async () => {
    mocks.spawnManagedProcess.mockImplementation(() => ({ child: fakeChild(null, 'SIGINT') }));
    const raise = vi.fn();
    const before = process.listenerCount('SIGINT');
    await expect(
      runStreamingScriptCommand('pnpm', ['run', 'tui'], 'tui', raise)
    ).rejects.toMatchObject({
      code: 130,
    });
    expect(raise).toHaveBeenCalledWith('SIGINT');
    // handlers are restored before the signal is re-raised
    expect(process.listenerCount('SIGINT')).toBe(before);
  });

  it('CU-02: forwards SIGTERM and SIGHUP to the streamed child', async () => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    mocks.spawnManagedProcess.mockImplementation(() => ({ child }));
    const running = runStreamingScriptCommand('pnpm', ['run', 'tui'], 'tui', vi.fn());
    process.emit('SIGHUP', 'SIGHUP');
    process.emit('SIGTERM', 'SIGTERM');
    expect(child.kill).toHaveBeenCalledWith('SIGHUP');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('exit', 0, null);
    await expect(running).resolves.toBeUndefined();
  });

  it('runs the streamed spawn through the exec policy with an allowlisted env', async () => {
    mocks.spawnManagedProcess.mockImplementation(() => ({ child: fakeChild(0) }));
    // The policy itself (shell-script / sensitive-text / execute_command) is
    // covered in secure-io's tests; here we only prove the streamed spawn
    // consults it first and does not spawn when it refuses.
    mocks.assertGovernedExec.mockImplementationOnce(() => {
      throw new Error('[SECURITY] refused by exec policy');
    });
    await expect(runStreamingScriptCommand('pnpm', ['run', 'tui'], 'bad', vi.fn())).rejects.toThrow(
      /SECURITY/u
    );
    expect(mocks.assertGovernedExec).toHaveBeenCalledWith('pnpm', ['run', 'tui']);
    expect(mocks.spawnManagedProcess).not.toHaveBeenCalled();

    const original = process.env.SECRET_TOKEN_FOR_TEST;
    process.env.SECRET_TOKEN_FOR_TEST = 'x';
    try {
      await main(['tui'], () => undefined);
    } finally {
      if (original === undefined) delete process.env.SECRET_TOKEN_FOR_TEST;
      else process.env.SECRET_TOKEN_FOR_TEST = original;
    }
    const env = mocks.spawnManagedProcess.mock.calls[0]?.[0].spawnOptions.env;
    expect(env).not.toHaveProperty('SECRET_TOKEN_FOR_TEST');
    expect(env).toHaveProperty('PATH');
  });

  it('uses pnpm.cmd on Windows in both the buffered and streamed paths', () => {
    expect(pnpmExecutable('win32')).toBe('pnpm.cmd');
    expect(pnpmExecutable('linux')).toBe('pnpm');
    expect(pnpmExecutable('darwin')).toBe('pnpm');
  });

  it('routes a deprecated alias with its passthrough arguments (onboard apply --identity x)', async () => {
    mocks.spawnManagedProcess.mockImplementation(() => ({ child: fakeChild(0) }));
    await main(['onboard', 'apply', '--identity', 'x'], () => undefined);
    const spec = mocks.spawnManagedProcess.mock.calls[0]?.[0];
    expect(spec.args.slice(-3)).toEqual(['apply', '--identity', 'x']);
  });
});
