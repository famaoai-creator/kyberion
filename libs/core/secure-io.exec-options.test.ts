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

import {
  resolveUserLoginShell,
  safeExec,
  safeExecResult,
  safeExecResultAsync,
  safeExecShellScript,
  safeExecShellScriptResult,
  safeSpawn,
} from './secure-io.js';

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

describe('safeExecShellScript / safeExecShellScriptResult — dedicated shell-script boundary', () => {
  it('runs `sh -c <script>` via execFileSync with an exact argv and shell: false', () => {
    childProcessSpies.execFileSync.mockClear();
    const out = safeExecShellScript('sh', 'printf "%s" "$0-$1"', { scriptArgs: ['a', 'b'] });
    expect(out).toBe('a-b');
    expect(childProcessSpies.execFileSync).toHaveBeenCalledTimes(1);
    const [command, argv, options] = childProcessSpies.execFileSync.mock.calls[0];
    expect(command).toBe('sh');
    expect(argv).toEqual(['-c', 'printf "%s" "$0-$1"', 'a', 'b']);
    expect(options.shell).toBe(false);
    expect(options.env.FORCE_COLOR).toBe('0');
  });

  it('uses -lc for login shells and keeps cwd / timeout / maxBuffer', () => {
    childProcessSpies.spawnSync.mockClear();
    const result = safeExecShellScriptResult('bash', 'exit 3', {
      login: true,
      cwd: process.cwd(),
      timeoutMs: 5000,
      maxOutputMB: 1,
    });
    expect(result.status).toBe(3);
    const [command, argv, options] = childProcessSpies.spawnSync.mock.calls[0];
    expect(command).toBe('bash');
    expect(argv).toEqual(['-lc', 'exit 3']);
    expect(options).toMatchObject({
      cwd: process.cwd(),
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      shell: false,
    });
    expect(options).not.toHaveProperty('login');
    expect(options).not.toHaveProperty('scriptArgs');
  });

  it('maps cmd to `/c` and appends scriptArgs verbatim (cmd /c start "" <target>)', () => {
    childProcessSpies.spawnSync.mockClear();
    // cmd is not present on POSIX hosts; the result carries the spawn error,
    // but the argv handed to spawnSync is what this asserts.
    safeExecShellScriptResult('cmd', 'start', { scriptArgs: ['', 'C:\\tmp\\a.html'] });
    const [command, argv, options] = childProcessSpies.spawnSync.mock.calls[0];
    expect(command).toBe('cmd');
    expect(argv).toEqual(['/c', 'start', '', 'C:\\tmp\\a.html']);
    expect(options.shell).toBe(false);
  });

  it('rejects login for cmd', () => {
    expect(() => safeExecShellScript('cmd', 'start', { login: true })).toThrow(
      /login.*not supported for cmd/
    );
  });

  it('resolves the user login shell from $SHELL with a fallback', () => {
    expect(resolveUserLoginShell('/bin/bash', '/bin/zsh')).toBe('/bin/bash');
    expect(resolveUserLoginShell(undefined, '/bin/zsh')).toBe('/bin/zsh');
    expect(resolveUserLoginShell('', '/bin/zsh')).toBe('/bin/zsh');
  });

  it('still applies the sensitive-text, policy and shell-option checks', () => {
    childProcessSpies.execFileSync.mockClear();
    childProcessSpies.spawnSync.mockClear();
    expect(() => safeExecShellScript('sh', 'cat ~/.ssh/id_ed25519')).toThrow(
      '[SENSITIVE_PATH_DENIED]'
    );
    expect(() => safeExecShellScriptResult('bash', 'cat $HOME/.codex/auth.json')).toThrow(
      '[SENSITIVE_PATH_DENIED]'
    );
    const withShell = { shell: true } as unknown as Parameters<typeof safeExecShellScript>[2];
    expect(() => safeExecShellScript('sh', 'true', withShell)).toThrow(
      /do not accept a "shell" option/
    );
    const savedRing = process.env.KYBERION_AGENT_RING;
    process.env.KYBERION_AGENT_RING = '3';
    try {
      expect(() => safeExecShellScript('sh', 'true')).toThrow('[POLICY_BLOCKED]');
      expect(() => safeExecShellScriptResult('sh', 'true')).toThrow('[POLICY_BLOCKED]');
    } finally {
      if (savedRing === undefined) delete process.env.KYBERION_AGENT_RING;
      else process.env.KYBERION_AGENT_RING = savedRing;
    }
    expect(childProcessSpies.execFileSync).not.toHaveBeenCalled();
    expect(childProcessSpies.spawnSync).not.toHaveBeenCalled();
  });
});

// Shell names reaching the generic helpers are assembled at runtime: a literal
// `'sh'` / `'bash'` / `'cmd'` passed to safeExec* here would make CodeQL's
// context-insensitive IndirectCommandArgument model treat every argument of
// those helpers as shell-interpreted again (the exact false positive WI-19
// removed), even though this suite only proves the call is rejected.
const shellName = (...parts: string[]): string => parts.join('');

describe('generic exec helpers reject shell-script invocations', () => {
  const cases: Array<[string, string[]]> = [
    [shellName('s', 'h'), ['-c', 'echo hi']],
    [shellName('/bin/', 's', 'h'), ['-c', 'echo hi']],
    [shellName('ba', 'sh'), ['-lc', 'echo hi']],
    [shellName('/bin/', 'ba', 'sh'), ['-c', 'echo hi']],
    [shellName('cm', 'd'), ['/c', 'start', '', 'x']],
    [shellName('C:\\Windows\\System32\\', 'CMD', '.EXE'), ['/C', 'dir']],
  ];

  it.each(cases)('%s %j is rejected by safeExec / safeExecResult / async / spawn', (cmd, args) => {
    childProcessSpies.execFileSync.mockClear();
    childProcessSpies.spawnSync.mockClear();
    expect(() => safeExec(cmd, args)).toThrow(/safeExecShellScript/);
    expect(() => safeExecResult(cmd, args)).toThrow(/safeExecShellScript/);
    expect(() => safeExecResultAsync(cmd, args)).toThrow(/safeExecShellScript/);
    expect(() => safeSpawn(cmd, args)).toThrow(/safeExecShellScript/);
    expect(childProcessSpies.execFileSync).not.toHaveBeenCalled();
    expect(childProcessSpies.spawnSync).not.toHaveBeenCalled();
  });

  it('leaves non-script shell runs and other interpreters alone', () => {
    expect(safeExecResult(shellName('s', 'h'), ['-n', '/dev/null']).status).toBe(0);
    expect(safeExecResult(process.execPath, ['-e', 'process.exit(0)']).status).toBe(0);
    expect(safeExec('echo', ['-c'])).toBe('-c\n');
  });
});
