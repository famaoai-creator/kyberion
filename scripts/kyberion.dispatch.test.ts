import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawnManagedProcess: vi.fn(),
  safeExecResultAsync: vi.fn(),
}));

vi.mock('@agent/core/managed-process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/managed-process')>()),
  spawnManagedProcess: mocks.spawnManagedProcess,
}));

vi.mock('@agent/core/secure-io', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/secure-io')>()),
  safeExecResultAsync: mocks.safeExecResultAsync,
}));

import { main } from './kyberion.js';
import { loadCliManifest } from './check_cli_manifest.js';

function fakeChild(exitCode: number) {
  const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
  setTimeout(() => child.emit('exit', exitCode, null), 0);
  return child;
}

describe('kyberion script-command dispatch', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.safeExecResultAsync.mockResolvedValue({ stdout: 'buffered\n', stderr: '', status: 0 });
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
});
