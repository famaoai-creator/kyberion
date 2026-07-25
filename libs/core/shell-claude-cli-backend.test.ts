import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  buildShellClaudeCliBackendFromEnv,
  probeShellClaudeCliAvailability,
  ShellClaudeCliBackend,
} from './shell-claude-cli-backend.js';

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

function createChild(stdoutText: string, exitCode = 0): any {
  const child = new EventEmitter() as any;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn();

  queueMicrotask(() => {
    child.stdout.write(stdoutText);
    child.stdout.end();
    child.stderr.end();
    child.emit('close', exitCode);
  });

  return child;
}

describe('shell-claude-cli-backend', () => {
  it('returns null when the availability probe fails', () => {
    const backend = buildShellClaudeCliBackendFromEnv(
      { KYBERION_CLAUDE_CLI_BIN: 'claude' } as NodeJS.ProcessEnv,
      () => ({ available: false, reason: 'crash on launch' })
    );

    expect(backend).toBeNull();
  });

  it('can report a missing binary as unavailable', () => {
    const probe = probeShellClaudeCliAvailability(
      { KYBERION_CLAUDE_CLI_BIN: '__definitely_missing_binary__' } as NodeJS.ProcessEnv,
      { bin: '__definitely_missing_binary__', timeoutMs: 250 }
    );

    expect(probe.available).toBe(false);
    expect(probe.reason).toBeTruthy();
  });

  describe('spawnCli env allowlisting (XP-02)', () => {
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    const previousUnrelated = process.env.UNRELATED_TEST_SECRET;

    afterEach(() => {
      spawnMock.mockClear();
      if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAiKey;
      if (previousUnrelated === undefined) delete process.env.UNRELATED_TEST_SECRET;
      else process.env.UNRELATED_TEST_SECRET = previousUnrelated;
    });

    it('spawns the CLI with an allowlisted env that excludes other providers credentials', async () => {
      process.env.OPENAI_API_KEY = 'fake-openai-key-should-not-leak';
      process.env.UNRELATED_TEST_SECRET = 'should-not-leak-either';
      spawnMock.mockReturnValueOnce(createChild('ok'));

      const backend = new ShellClaudeCliBackend({ bin: 'claude' });
      await backend.delegateTask('do the thing');

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [, , spawnOptions] = spawnMock.mock.calls[0];
      expect(spawnOptions.env.PATH).toBe(process.env.PATH);
      expect(spawnOptions.env.OPENAI_API_KEY).toBeUndefined();
      expect(spawnOptions.env.UNRELATED_TEST_SECRET).toBeUndefined();
    });
  });

  describe('declarative permission profile argv (XP-02 follow-up)', () => {
    afterEach(() => {
      spawnMock.mockClear();
    });

    it('no profile: argv is byte-identical to the pre-profile baseline', async () => {
      spawnMock.mockReturnValueOnce(createChild('ok'));

      const backend = new ShellClaudeCliBackend({ bin: 'claude', model: 'opus' });
      await backend.delegateTask('do the thing', 'ctx');

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [, argv] = spawnMock.mock.calls[0];
      expect(argv).toEqual(['-p', 'do the thing\n\nContext: ctx', '--model', 'opus']);
    });

    it('explorer profile: argv carries the read-only mapping and not write/exec flags', async () => {
      spawnMock.mockReturnValueOnce(createChild('ok'));

      const backend = new ShellClaudeCliBackend({ bin: 'claude', model: 'opus' });
      await backend.delegateTask('do the thing', undefined, { profile: 'explorer' });

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [, argv] = spawnMock.mock.calls[0];
      expect(argv).toContain('--allowedTools');
      expect(argv).toEqual(expect.arrayContaining(['Read', 'Glob', 'Grep', 'WebFetch']));
      expect(argv).toContain('--disallowedTools');
      expect(argv).not.toContain('bypassPermissions');
      expect(argv).not.toContain('--dangerously-skip-permissions');
      // permission-mode is 'default' for explorer, never 'bypassPermissions'
      const permissionModeIndex = argv.indexOf('--permission-mode');
      expect(argv[permissionModeIndex + 1]).toBe('default');
    });

    it('planner profile on claude: grants plan mode (not a refusal)', async () => {
      spawnMock.mockReturnValueOnce(createChild('ok'));

      const backend = new ShellClaudeCliBackend({ bin: 'claude', model: 'opus' });
      await backend.delegateTask('do the thing', undefined, { profile: 'planner' });

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [, argv] = spawnMock.mock.calls[0];
      const permissionModeIndex = argv.indexOf('--permission-mode');
      expect(argv[permissionModeIndex + 1]).toBe('plan');
    });
  });
});
