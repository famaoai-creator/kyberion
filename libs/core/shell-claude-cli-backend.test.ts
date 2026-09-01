import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  buildShellClaudeCliBackendFromEnv,
  isClaudeCliPlaceholderFailure,
  probeShellClaudeCliAvailability,
  resolveClaudeCliFallbackCandidates,
  ShellClaudeCliBackend,
} from './shell-claude-cli-backend.js';
import { resolveSandboxPolicy, withSandboxPolicy } from './sandbox-policy.js';

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

  describe('LC-03 placeholder shadowing fallback', () => {
    afterEach(() => {
      spawnMock.mockClear();
    });

    it('recognizes the pnpm placeholder failure signature', () => {
      expect(isClaudeCliPlaceholderFailure('Error: claude native binary not installed.')).toBe(
        true
      );
      expect(isClaudeCliPlaceholderFailure('Claude Native Binary NOT Installed')).toBe(true);
      expect(isClaudeCliPlaceholderFailure('command not found')).toBe(false);
      expect(isClaudeCliPlaceholderFailure(undefined)).toBe(false);
    });

    it('resolves fallback candidates deterministically, excluding node_modules/.bin PATH entries', () => {
      const existing = new Set([
        '/home/op/.local/bin/claude',
        '/usr/local/bin/claude',
        '/extra/tools/claude',
      ]);
      const candidates = resolveClaudeCliFallbackCandidates({
        env: {
          PATH: [
            '/repo/node_modules/.bin',
            '/extra/tools',
            '/home/op/.local/bin', // duplicate of the well-known entry
            '',
          ].join(':'),
        } as NodeJS.ProcessEnv,
        home: '/home/op',
        exists: (candidate) => existing.has(candidate),
      });

      expect(candidates).toEqual([
        '/home/op/.local/bin/claude',
        '/usr/local/bin/claude',
        '/extra/tools/claude',
      ]);
      expect(candidates).not.toContain('/repo/node_modules/.bin/claude');
    });

    it('returns no candidates when nothing exists on disk', () => {
      expect(
        resolveClaudeCliFallbackCandidates({
          env: { PATH: '/a:/b' } as NodeJS.ProcessEnv,
          home: '/home/op',
          exists: () => false,
        })
      ).toEqual([]);
    });

    it('buildShellClaudeCliBackendFromEnv uses the probe-selected fallback binary', async () => {
      spawnMock.mockReturnValueOnce(createChild('ok'));

      const backend = buildShellClaudeCliBackendFromEnv({} as NodeJS.ProcessEnv, () => ({
        available: true,
        bin: '/home/op/.local/bin/claude',
      }));

      expect(backend).not.toBeNull();
      await backend!.delegateTask('do the thing');
      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [spawnedBin] = spawnMock.mock.calls[0];
      expect(spawnedBin).toBe('/home/op/.local/bin/claude');
    });

    it('an explicit KYBERION_CLAUDE_CLI_BIN wins over the probe-selected binary', async () => {
      spawnMock.mockReturnValueOnce(createChild('ok'));

      const backend = buildShellClaudeCliBackendFromEnv(
        { KYBERION_CLAUDE_CLI_BIN: '/pinned/claude' } as NodeJS.ProcessEnv,
        () => ({ available: true, bin: '/home/op/.local/bin/claude' })
      );

      expect(backend).not.toBeNull();
      await backend!.delegateTask('do the thing');
      const [spawnedBin] = spawnMock.mock.calls[0];
      expect(spawnedBin).toBe('/pinned/claude');
    });

    it('allows a governed route model to override the CLI environment default', async () => {
      spawnMock.mockReturnValueOnce(createChild('ok'));

      const backend = buildShellClaudeCliBackendFromEnv(
        { KYBERION_CLAUDE_CLI_MODEL: 'opus' } as NodeJS.ProcessEnv,
        () => ({ available: true, bin: '/home/op/.local/bin/claude' }),
        'claude-opus-5'
      );

      expect(backend).not.toBeNull();
      await backend!.delegateTask('do the thing');
      const [, argv] = spawnMock.mock.calls[0];
      expect(argv).toContain('--model');
      expect(argv[argv.indexOf('--model') + 1]).toBe('claude-opus-5');
    });
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

    it('ambient read-only sandbox applies the explorer mapping to an unprofiled delegation', async () => {
      spawnMock.mockReturnValueOnce(createChild('ok'));
      const policy = resolveSandboxPolicy({
        provider: 'claude',
        mode: 'read-only',
        networkAccess: true,
      });
      const backend = new ShellClaudeCliBackend({ bin: 'claude', model: 'opus' });

      await withSandboxPolicy(policy, () => backend.delegateTask('inspect the thing'));

      const [, argv] = spawnMock.mock.calls[0];
      expect(argv).toContain('--allowedTools');
      expect(argv).not.toContain('bypassPermissions');
      expect(argv).not.toContain('--dangerously-skip-permissions');
    });
  });

  describe('native subagent adopter (CN-02)', () => {
    const previousFlag = process.env.KYBERION_CLAUDE_NATIVE_SUBAGENT;

    beforeEach(() => {
      delete process.env.KYBERION_CLAUDE_NATIVE_SUBAGENT;
      spawnMock.mockClear();
    });

    afterEach(() => {
      if (previousFlag === undefined) delete process.env.KYBERION_CLAUDE_NATIVE_SUBAGENT;
      else process.env.KYBERION_CLAUDE_NATIVE_SUBAGENT = previousFlag;
    });

    function fakeHarness(response: Record<string, unknown>) {
      return {
        boot: vi.fn(async () => {}),
        ask: vi.fn(async () => ({ text: 'plain', stopReason: 'completed' })),
        askNativeSubagent: vi.fn(async () => response as any),
        shutdown: vi.fn(async () => {}),
      };
    }

    it('stays off by default so the historical per-task spawn path is unchanged', () => {
      const backend = new ShellClaudeCliBackend({ bin: 'claude' });

      expect(backend.getNativeSubagentAdopter()).toBeNull();
      expect(backend.requiresNativeSubagent()).toBe(false);
    });

    it('turns on via KYBERION_CLAUDE_NATIVE_SUBAGENT=1', () => {
      process.env.KYBERION_CLAUDE_NATIVE_SUBAGENT = '1';
      const backend = new ShellClaudeCliBackend({ bin: 'claude' });

      expect(backend.getNativeSubagentAdopter()?.id).toBe('claude-cli');
      expect(backend.requiresNativeSubagent()).toBe(true);
    });

    it('delegates through the shared session and reports provider-observed metadata', async () => {
      const harness = fakeHarness({
        text: 'sub-agent report',
        stopReason: 'completed',
        metadata: {
          nativeSubagent: {
            provider: 'claude',
            mode: 'cli-stream-json',
            threadId: 'sess-9',
            turnId: 'toolu_9',
          },
        },
      });
      const backend = new ShellClaudeCliBackend({ bin: 'claude', harnessSession: harness });
      const adopter = backend.getNativeSubagentAdopter();

      const result = await adopter!.dispatch('do the thing', 'mission ctx', {
        profile: 'explorer',
      });

      expect(result).toBe('sub-agent report');
      expect(spawnMock).not.toHaveBeenCalled();
      expect(harness.askNativeSubagent).toHaveBeenCalledTimes(1);
      const [prompt, options] = harness.askNativeSubagent.mock.calls[0] as [string, any];
      expect(prompt).toContain('subagent_type: "kyberion-explorer"');
      expect(prompt).toContain('run_in_background: false');
      expect(prompt).toContain('Task: do the thing');
      expect(prompt).toContain('mission ctx');
      expect(options).toMatchObject({ profile: 'explorer', subagent: true, effort: 'medium' });
      expect(adopter!.getInfo?.()).toMatchObject({ provider: 'claude', threadId: 'sess-9' });
    });

    it('fails closed when the session cannot prove a native delegation happened', async () => {
      const harness = fakeHarness({ text: 'plain answer', stopReason: 'completed' });
      const backend = new ShellClaudeCliBackend({ bin: 'claude', harnessSession: harness });

      await expect(backend.getNativeSubagentAdopter()!.dispatch('do the thing')).rejects.toThrow(
        '[SUBAGENT_UNAVAILABLE] claude CLI session returned no native subagent metadata.'
      );
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('degrades an unknown profile to implementer instead of failing', async () => {
      const harness = fakeHarness({
        text: 'ok',
        stopReason: 'completed',
        metadata: { nativeSubagent: { provider: 'claude' } },
      });
      const backend = new ShellClaudeCliBackend({ bin: 'claude', harnessSession: harness });

      await backend.getNativeSubagentAdopter()!.dispatch('do it', undefined, {
        profile: 'not-a-tier',
      });

      const [, options] = harness.askNativeSubagent.mock.calls[0] as [string, any];
      expect(options.profile).toBe('implementer');
    });

    it('resets the session on failover but never shuts down an injected one (QM-06)', async () => {
      const harness = fakeHarness({
        text: 'ok',
        stopReason: 'completed',
        metadata: { nativeSubagent: { provider: 'claude' } },
      });
      const backend = new ShellClaudeCliBackend({ bin: 'claude', harnessSession: harness });
      await backend.getNativeSubagentAdopter()!.dispatch('do it');

      await backend.resetSession();

      expect(harness.shutdown).not.toHaveBeenCalled();
      expect(backend.getNativeSubagentAdopter()!.getInfo?.()).toBeNull();
    });

    it('re-boots the owned session when the tier or model signature changes', () => {
      const backend = new ShellClaudeCliBackend({ bin: 'claude' }) as any;

      const first = backend.getHarnessSession('explorer', 'sonnet', 'medium');
      const same = backend.getHarnessSession('explorer', 'sonnet', 'medium');
      expect(same).toBe(first);

      const shutdown = vi.spyOn(first, 'shutdown').mockResolvedValue(undefined);
      const switched = backend.getHarnessSession('implementer', 'sonnet', 'medium');
      expect(switched).not.toBe(first);
      expect(shutdown).toHaveBeenCalledTimes(1);
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
