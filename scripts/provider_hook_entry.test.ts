import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { runProviderHook } from './provider_hook_entry.mjs';

describe('stable provider hook bootstrap', () => {
  it('returns native deny with success exit status when a real ESM import fails', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { runProviderHook } from './scripts/provider_hook_entry.mjs';
      await runProviderHook('claude', 'PreToolUseShellDeny', {
        load: () => import('./dist/scripts/definitely-missing-hook-runtime.js'),
      });
    `,
      ],
      { encoding: 'utf8', input: '{}' }
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.stderr).toContain('wait for pnpm build');
    expect(result.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
  });

  it('passes stdin into the real built hook without invoking it twice', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/provider_hook_entry.mjs', 'codex', 'PostToolUse'],
      { encoding: 'utf8', input: '{}' }
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  for (const missing of ['entry', 'dependency']) {
    const load = async () => {
      const error = new Error(`Cannot find module /repo/dist/${missing}.js`);
      Object.assign(error, { code: 'ERR_MODULE_NOT_FOUND' });
      throw error;
    };

    it(`keeps coordination usable when the built ${missing} is missing`, async () => {
      for (const provider of ['codex', 'claude', 'gemini']) {
        const stdout = vi.fn();
        const stderr = vi.fn();
        await runProviderHook(provider, 'SessionStart', { load, stdout, stderr });
        expect(stdout).not.toHaveBeenCalled();
        expect(stderr).toHaveBeenCalledOnce();
        expect(stderr.mock.calls[0]![0]).toContain('wait for pnpm build');
      }
    });

    it(`denies policy events when the built ${missing} is missing`, async () => {
      for (const event of ['PreToolUse', 'PreToolUseShellDeny']) {
        const stdout = vi.fn();
        await runProviderHook('claude', event, { load, stdout, stderr: vi.fn() });
        expect(JSON.parse(stdout.mock.calls[0]![0]).hookSpecificOutput).toMatchObject({
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
        });
      }
      const stdout = vi.fn();
      await runProviderHook('gemini', 'BeforeTool', { load, stdout, stderr: vi.fn() });
      expect(JSON.parse(stdout.mock.calls[0]![0]).decision).toBe('deny');
    });
  }

  it('calls the exported runner once with the original event', async () => {
    for (const [provider, name] of [
      ['codex', 'runCodexCliHook'],
      ['claude', 'claudeCodeHook'],
      ['gemini', 'runGeminiCliHook'],
    ]) {
      const run = vi.fn();
      const load = vi.fn(async () => ({ [name!]: run }));
      const stdout = vi.fn();
      await runProviderHook(provider, 'PostToolUse', { load, stdout, stderr: vi.fn() });
      expect(run).toHaveBeenCalledExactlyOnceWith(['PostToolUse']);
      expect(stdout).not.toHaveBeenCalled();
    }
  });

  it('emits a bounded diagnostic without leaking loader details', async () => {
    const stderr = vi.fn();
    await runProviderHook('codex', 'PostToolUse', {
      load: async () => {
        throw new Error('sensitive details'.repeat(1000));
      },
      stdout: vi.fn(),
      stderr,
    });
    expect(stderr.mock.calls[0]![0].length).toBeLessThan(200);
    expect(stderr.mock.calls[0]![0]).not.toContain('sensitive');
  });

  it('preserves runtime errors without adding conflicting bootstrap output', async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const error = new Error('runtime failure');
    await expect(
      runProviderHook('claude', 'PreToolUse', {
        load: async () => ({
          claudeCodeHook: async () => {
            throw error;
          },
        }),
        stdout,
        stderr,
      })
    ).rejects.toBe(error);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });
});
