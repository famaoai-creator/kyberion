import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync } from '../secure-io.js';
import { probeClaudeTenantIsolation } from './claude-tenant-isolation-canary.js';

type Call = { args: string[]; options: { cwd?: string; env?: Record<string, string | undefined> } };

function fakeExec(authStdout: (args: string[]) => string, authStatus = 1) {
  const calls: Call[] = [];
  const exec = vi.fn((_bin: string, args: string[], options: Call['options'] = {}) => {
    calls.push({ args, options });
    if (args[0] === '--version') return { stdout: '2.1.325 (Claude Code)', stderr: '', status: 0 };
    return { stdout: authStdout(args), stderr: '', status: authStatus };
  });
  return { exec, calls };
}

describe('claude-tenant-isolation doctor canary', () => {
  it('passes when the isolated, credential-free launch reports not logged in (both kinds)', async () => {
    const { exec, calls } = fakeExec(() => JSON.stringify({ loggedIn: false, authMethod: 'none' }));
    await expect(probeClaudeTenantIsolation({ exec, bin: 'claude' })).resolves.toEqual({
      available: true,
    });
    const auth = calls.filter((call) => call.args.includes('auth'));
    expect(auth.map((call) => call.args)).toEqual([
      ['--bare', 'auth', 'status', '--json'],
      ['auth', 'status', '--json'],
    ]);
    const scratch = pathResolver.rootResolve('active/shared/tmp/system/claude-tenant-isolation');
    for (const { options } of auth) {
      const env = options.env!;
      expect(path.relative(scratch, env.HOME!)).not.toMatch(/^\.\./);
      expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(env.HOME!, '.claude'));
      expect(env).toMatchObject({
        DISABLE_AUTOUPDATER: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      });
      // No credential of any kind is handed to the canary.
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(options.cwd).toBeDefined();
      // The scratch root is removed after the probe.
      expect(safeExistsSync(path.dirname(env.HOME!))).toBe(false);
    }
  });

  it('fails when the credential-free launch reports a login (isolation broken)', async () => {
    const { exec } = fakeExec(
      (args) => JSON.stringify({ loggedIn: !args.includes('--bare'), authMethod: 'claude.ai' }),
      0
    );
    const result = await probeClaudeTenantIsolation({ exec, bin: 'claude' });
    expect(result.available).toBe(false);
    expect(result.reason).toContain('isolation broken');
    expect(result.reason).toContain('subscription_token');
  });

  it('cannot be satisfied by unreadable output on a successful exit', async () => {
    const { exec } = fakeExec(() => 'Logged in', 0);
    const result = await probeClaudeTenantIsolation({ exec, bin: 'claude' });
    expect(result).toMatchObject({ available: false });
  });

  it('is skipped (satisfied) when no claude CLI is installed', async () => {
    const exec = vi.fn(() => ({
      stdout: '',
      stderr: '',
      status: null,
      error: new Error('spawn claude ENOENT'),
    }));
    const result = await probeClaudeTenantIsolation({ exec, bin: 'claude' });
    expect(result).toMatchObject({ available: true });
    expect(result.reason).toContain('skipped');
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('never starts the real CLI under Vitest without an injected exec', async () => {
    await expect(probeClaudeTenantIsolation()).resolves.toMatchObject({ available: true });
  });
});
