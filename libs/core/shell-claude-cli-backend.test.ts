import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

// XP-06: `spawnCli` now wraps its child in `withWallClockBudget`, which
// (unmocked) would persist a real active-child record via `secure-io` /
// `path-resolver` — a real filesystem write this suite must not perform.
// `delegation-concurrency.test.ts` owns the hermetic (temp-dir-backed) tests
// for the budget/kill machinery itself; here it's a spyable passthrough so
// every pre-existing assertion below (argv shape, env allowlisting) is
// unaffected, while still letting this file assert *that* `spawnCli` wires
// through it with the right provider/budget.
const { withWallClockBudgetMock } = vi.hoisted(() => ({
  withWallClockBudgetMock: vi.fn((_opts: unknown, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./delegation-concurrency.js', () => ({
  delegationChildHandleFromChildProcess: (child: any) => ({
    pid: child.pid,
    kill: (signal: NodeJS.Signals) => child.kill(signal),
  }),
  withWallClockBudget: withWallClockBudgetMock,
  DelegationWallClockExceededError: class DelegationWallClockExceededError extends Error {},
}));

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

  describe('wall-clock budget wiring (XP-06)', () => {
    beforeEach(() => {
      spawnMock.mockClear();
      withWallClockBudgetMock.mockClear();
    });

    afterEach(() => {
      spawnMock.mockClear();
      withWallClockBudgetMock.mockClear();
    });

    it('wraps the spawned child in withWallClockBudget with the claude provider and configured timeout', async () => {
      spawnMock.mockReturnValueOnce(createChild('ok'));

      const backend = new ShellClaudeCliBackend({ bin: 'claude', timeoutMs: 12345 });
      const controller = new AbortController();
      await backend.delegateTask('do the thing', undefined, { signal: controller.signal });

      expect(withWallClockBudgetMock).toHaveBeenCalledTimes(1);
      const [opts, fn] = withWallClockBudgetMock.mock.calls[0];
      expect(opts).toMatchObject({ provider: 'claude', budgetMs: 12345 });
      expect(opts.signal).toBe(controller.signal);
      expect(opts.child).toEqual(expect.objectContaining({ kill: expect.any(Function) }));
      expect(typeof fn).toBe('function');
    });
  });
});
