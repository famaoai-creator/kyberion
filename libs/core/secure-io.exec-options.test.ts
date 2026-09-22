import { describe, it, expect, vi } from 'vitest';

// `node:child_process` is a native ESM namespace whose exports are
// non-configurable, so `vi.spyOn` cannot redefine `spawnSync`/`execFileSync`
// directly. Mocking the module with a `vi.fn` wrapper around the real
// implementation (same pattern as the `node:fs.readSync` spy in
// secure-io.test.ts) keeps behaviour real while giving these tests a
// spyable reference to assert the exact options passed to the sink.
const childProcessSpies = vi.hoisted(() => ({
  spawnSync: undefined as unknown as ReturnType<typeof vi.fn>,
  execFileSync: undefined as unknown as ReturnType<typeof vi.fn>,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  childProcessSpies.spawnSync = vi.fn(actual.spawnSync);
  childProcessSpies.execFileSync = vi.fn(actual.execFileSync);
  return {
    ...actual,
    spawnSync: childProcessSpies.spawnSync,
    execFileSync: childProcessSpies.execFileSync,
  };
});

import { safeExec, safeExecResult } from './secure-io.js';

describe('safeExecResult / safeExec — shell option hardening (CodeQL js/shell-command-constructed-from-input)', () => {
  it('safeExecResult invokes spawnSync with an explicit shell: false', () => {
    childProcessSpies.spawnSync.mockClear();
    const result = safeExecResult('echo', ['hi']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('hi');
    expect(childProcessSpies.spawnSync).toHaveBeenCalledTimes(1);
    const optionsArg = childProcessSpies.spawnSync.mock.calls[0][2];
    expect(optionsArg.shell).toBe(false);
  });

  it('safeExec invokes execFileSync with an explicit shell: false', () => {
    childProcessSpies.execFileSync.mockClear();
    const output = safeExec('echo', ['-n', 'ok']);
    expect(output).toBe('ok');
    expect(childProcessSpies.execFileSync).toHaveBeenCalledTimes(1);
    const optionsArg = childProcessSpies.execFileSync.mock.calls[0][2];
    expect(optionsArg.shell).toBe(false);
  });

  it('rejects a caller-supplied "shell" option for safeExecResult', () => {
    const optionsWithShell = { shell: true } as unknown as Parameters<typeof safeExecResult>[2];
    expect(() => safeExecResult('echo', ['hi'], optionsWithShell)).toThrow(
      /do not accept a "shell" option/
    );
    // The policy-gated / sensitive-path-checked spawnSync boundary must never
    // be reached once the option is rejected.
    expect(childProcessSpies.spawnSync).not.toHaveBeenCalled();
  });

  it('rejects a caller-supplied "shell" option for safeExec', () => {
    const optionsWithShell = { shell: false } as unknown as Parameters<typeof safeExec>[2];
    expect(() => safeExec('echo', ['hi'], optionsWithShell)).toThrow(
      /do not accept a "shell" option/
    );
    expect(childProcessSpies.execFileSync).not.toHaveBeenCalled();
  });

  it('leaves existing safeExecResult/safeExec behaviour unchanged for valid options', () => {
    const execResult = safeExecResult('echo', ['hello'], {
      timeoutMs: 5000,
      cwd: process.cwd(),
      maxOutputMB: 1,
    });
    expect(execResult.status).toBe(0);
    expect(execResult.stdout.trim()).toBe('hello');
    expect(execResult.error).toBeUndefined();

    const out = safeExec('echo', ['hello'], { timeoutMs: 5000, cwd: process.cwd() });
    expect(out.trim()).toBe('hello');
  });

  it('still surfaces a non-zero exit code from safeExecResult without throwing', () => {
    const result = safeExecResult(process.execPath, ['-e', 'process.exit(3)']);
    expect(result.status).toBe(3);
  });
});
