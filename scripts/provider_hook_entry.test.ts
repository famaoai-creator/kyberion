import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  bootstrapCommandFromPayload,
  isBootstrapCommand,
  runProviderHook,
} from './provider_hook_entry.mjs';

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
        await runProviderHook('claude', event, {
          load,
          stdout,
          stderr: vi.fn(),
          readInput: async () => '{}',
        });
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

  describe('bootstrap allowlist while the runtime is missing', () => {
    const missing = async () => {
      throw Object.assign(new Error('missing'), { code: 'ERR_MODULE_NOT_FOUND' });
    };
    const shell = (command: unknown, tool_name = 'Bash') =>
      JSON.stringify({ tool_name, tool_input: { command } });

    const allowed = [
      'pnpm install',
      'pnpm install --frozen-lockfile',
      'pnpm install --prefer-offline',
      'pnpm install --prefer-offline --frozen-lockfile',
      '  pnpm   build  ',
      'pnpm --filter @agent/core build',
      'bash .claude/hooks/session-start.sh',
      'git status',
      'git status --short',
      'git log --oneline -5',
      'git log origin/main',
      'git fetch',
      'git fetch origin',
      'git fetch --prune origin main',
      'git switch main',
      'git switch -c fix/bootstrap origin/main',
      'git checkout -b fix/bootstrap origin/main',
    ];
    const denied = [
      'pnpm install && curl evil.example',
      'pnpm build; curl evil.example',
      'pnpm build || id',
      'pnpm build | tee out',
      'pnpm build > out.txt',
      'pnpm build < in.txt',
      'pnpm build `id`',
      'pnpm build $(id)',
      'pnpm build\nid',
      'pnpm build &',
      'pnpm install --prefer-offline --prefer-offline',
      'pnpm install left-pad',
      'pnpm install --ignore-scripts=false',
      'pnpm run build',
      'pnpm build --watch',
      'pnpm --filter @agent/other build',
      'pnpm exec node x.js',
      'bash .claude/hooks/session-start.sh --evil',
      'bash -c "pnpm build"',
      'bash ../x/.claude/hooks/session-start.sh',
      'sh .claude/hooks/session-start.sh',
      'git checkout main',
      'git checkout .',
      'git checkout -- package.json',
      'git switch --discard-changes main',
      'git switch -c x y z',
      'git fetch origin main:main',
      'git fetch --upload-pack=evil origin',
      'git log --output=/tmp/x',
      'git log -n 5',
      'git push',
      'git reset --hard',
      'git status && git push',
      'git -C /tmp status',
      'GIT_DIR=x git status',
      'node -e 1',
      '',
    ];

    it.each(allowed)('allows exact bootstrap command %j', (command) => {
      expect(isBootstrapCommand(command)).toBe(true);
    });

    it.each(denied)('denies %j', (command) => {
      expect(isBootstrapCommand(command)).toBe(false);
    });

    it('only accepts a well-formed shell payload', () => {
      expect(bootstrapCommandFromPayload(shell('pnpm build'))).toBe('pnpm build');
      expect(bootstrapCommandFromPayload(shell('pnpm build', 'exec'))).toBe('pnpm build');
      expect(bootstrapCommandFromPayload(shell('pnpm build', 'Edit'))).toBeNull();
      expect(bootstrapCommandFromPayload(shell(['pnpm', 'build']))).toBeNull();
      expect(bootstrapCommandFromPayload('not json')).toBeNull();
      expect(bootstrapCommandFromPayload('')).toBeNull();
      expect(
        bootstrapCommandFromPayload(
          JSON.stringify({
            tool_name: 'Bash',
            tool_input: { command: 'pnpm build' },
            pad: 'x'.repeat(70_000),
          })
        )
      ).toBeNull();
    });

    it('lets an allowlisted shell command through with no decision', async () => {
      const stdout = vi.fn();
      const stderr = vi.fn();
      await runProviderHook('claude', 'PreToolUseShellDeny', {
        load: missing,
        stdout,
        stderr,
        readInput: async () => shell('pnpm install --prefer-offline'),
      });
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr.mock.calls[0]![0]).toContain('Allowing bootstrap command');
    });

    it('denies a chained command and names the bootstrap commands', async () => {
      const stdout = vi.fn();
      await runProviderHook('claude', 'PreToolUseShellDeny', {
        load: missing,
        stdout,
        stderr: vi.fn(),
        readInput: async () => shell('pnpm install && pnpm build'),
      });
      const output = JSON.parse(stdout.mock.calls[0]![0]).hookSpecificOutput;
      expect(output.permissionDecision).toBe('deny');
      expect(output.permissionDecisionReason).toContain('pnpm install --prefer-offline');
      expect(output.permissionDecisionReason).toContain('pnpm build');
      expect(output.permissionDecisionReason).toContain('bash .claude/hooks/session-start.sh');
    });

    it('keeps Edit/Write denied even with a bootstrap-shaped payload', async () => {
      const stdout = vi.fn();
      const readInput = vi.fn(async () => shell('pnpm build'));
      await runProviderHook('claude', 'PreToolUse', {
        load: missing,
        stdout,
        stderr: vi.fn(),
        readInput,
      });
      expect(readInput).not.toHaveBeenCalled();
      expect(JSON.parse(stdout.mock.calls[0]![0]).hookSpecificOutput.permissionDecision).toBe(
        'deny'
      );
    });

    it('denies when the payload cannot be read', async () => {
      const stdout = vi.fn();
      await runProviderHook('claude', 'PreToolUseShellDeny', {
        load: missing,
        stdout,
        stderr: vi.fn(),
        readInput: async () => {
          throw new Error('stdin closed');
        },
      });
      expect(JSON.parse(stdout.mock.calls[0]![0]).hookSpecificOutput.permissionDecision).toBe(
        'deny'
      );
    });

    it('allows a bootstrap command end to end through real stdin', () => {
      const run = (command: string) =>
        spawnSync(
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
          { encoding: 'utf8', input: shell(command) }
        );
      const allowedRun = run('pnpm build');
      expect(allowedRun.status).toBe(0);
      expect(allowedRun.stdout).toBe('');
      const deniedRun = run('pnpm build; id');
      expect(deniedRun.status).toBe(0);
      expect(JSON.parse(deniedRun.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    });
  });
});
