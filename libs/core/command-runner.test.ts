import { describe, expect, it, vi } from 'vitest';

const safeExecResult = vi.fn();
const safeExecShellScriptResult = vi.fn();
vi.mock('./secure-io.js', () => ({ safeExecResult, safeExecShellScriptResult }));

describe('command-runner', () => {
  it('returns structured command results', async () => {
    safeExecResult.mockReturnValue({ stdout: '{"ok":true}', stderr: '', status: 0 });
    const { runGovernedCommand, runGovernedJsonCommand } = await import('./command-runner.js');
    expect(runGovernedCommand('tool', ['--json'])).toEqual({
      stdout: '{"ok":true}',
      stderr: '',
      status: 0,
    });
    expect(runGovernedJsonCommand<{ ok: boolean }>('tool', ['--json'])).toEqual({ ok: true });
  });

  it('routes intentional shell scripts to the dedicated secure-io shell-script helper', async () => {
    safeExecShellScriptResult.mockReturnValue({ stdout: 'ok', stderr: '', status: 0 });
    const { runGovernedShellScript } = await import('./command-runner.js');
    expect(runGovernedShellScript('/bin/sh', 'echo ok', { maxOutputMB: 10 })).toEqual({
      stdout: 'ok',
      stderr: '',
      status: 0,
    });
    expect(safeExecShellScriptResult).toHaveBeenCalledWith('/bin/sh', 'echo ok', {
      maxOutputMB: 10,
    });
    expect(safeExecResult).not.toHaveBeenCalledWith(
      '/bin/sh',
      expect.anything(),
      expect.anything()
    );
  });
});
