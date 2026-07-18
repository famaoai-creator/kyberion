import { describe, expect, it, vi } from 'vitest';

const safeExecResult = vi.fn();
vi.mock('./secure-io.js', () => ({ safeExecResult }));

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
});
