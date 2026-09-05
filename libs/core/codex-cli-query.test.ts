import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { z } from 'zod';
import {
  buildCodexCliQueryOptionsFromEnv,
  resolveCodexBinary,
  runCodexCliQuery,
} from './codex-cli-query.js';
import { resolveSandboxPolicy, withSandboxPolicy } from './sandbox-policy.js';

const mocks = vi.hoisted(() => ({
  safeExecResult: vi.fn(),
  safeWriteFile: vi.fn(),
  safeReadFile: vi.fn(),
  safeRmSync: vi.fn(),
  spawnMock: vi.fn(),
  withWallClockBudgetMock: vi.fn((_opts: unknown, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('./secure-io.js', async () => {
  const actual = await vi.importActual<typeof import('./secure-io.js')>('./secure-io.js');
  return {
    ...actual,
    safeExecResult: mocks.safeExecResult,
    safeWriteFile: mocks.safeWriteFile,
    safeReadFile: mocks.safeReadFile,
    safeRmSync: mocks.safeRmSync,
  };
});

vi.mock('./foundation/text.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./foundation/text.js')>();
  return {
    ...actual,
    readTextFile: (filePath: string) => mocks.safeReadFile(filePath),
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: mocks.spawnMock };
});

// XP-06: `spawnCli` now wraps its child in `withWallClockBudget`, which
// (unmocked) would persist a real active-child record via `secure-io` /
// `path-resolver` — a real filesystem write this suite must not perform.
// `delegation-concurrency.test.ts` owns the hermetic (temp-dir-backed) tests
// for that wiring; here it's a pure passthrough so every pre-existing
// assertion below is unaffected.
vi.mock('./delegation-concurrency.js', () => ({
  delegationChildHandleFromChildProcess: (child: any) => ({
    pid: child.pid,
    kill: (signal: NodeJS.Signals) => child.kill(signal),
  }),
  withWallClockBudget: mocks.withWallClockBudgetMock,
  DelegationWallClockExceededError: class DelegationWallClockExceededError extends Error {},
}));

function createChild(exitCode = 0): any {
  const child = new EventEmitter() as any;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn();

  queueMicrotask(() => {
    child.stdout.end();
    child.stderr.end();
    child.emit('close', exitCode);
  });

  return child;
}

describe('codex-cli-query', () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'linux',
    });
    mocks.safeExecResult.mockReturnValue({
      stdout: 'fake/system/codex\nfake/project/node_modules/.bin/codex',
      stderr: '',
      status: 0,
    });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform,
    });
    vi.clearAllMocks();
  });

  it('defers binary discovery when no explicit override is provided', () => {
    const options = buildCodexCliQueryOptionsFromEnv({
      PATH: [
        'fake/system',
        'fake/fallback',
        'fake/project/node_modules/.bin',
        'fake/alternate',
      ].join(':'),
    } as NodeJS.ProcessEnv);

    expect(options.bin).toBeUndefined();
    expect(mocks.safeExecResult).not.toHaveBeenCalled();
  });

  it('keeps an explicit override when provided', () => {
    const options = buildCodexCliQueryOptionsFromEnv({
      PATH: 'fake/system:fake/project/node_modules/.bin:fake/other',
      KYBERION_CODEX_CLI_BIN: 'fake/custom/codex',
    } as NodeJS.ProcessEnv);

    expect(options.bin).toBe('fake/custom/codex');
  });

  it('resolves the first non-project-local Codex binary from PATH candidates', () => {
    mocks.safeExecResult.mockReturnValue({
      stdout:
        'fake/repo/node_modules/.bin/codex\nfake/user/.codex/tmp/arg0/codex\nfake/system/codex',
      stderr: '',
      status: 0,
    });

    expect(
      resolveCodexBinary({ PATH: 'fake/repo/node_modules/.bin:fake/system' } as NodeJS.ProcessEnv)
    ).toBe('fake/system/codex');
  });

  it('fails closed when every PATH candidate is a pnpm project-local shim', () => {
    mocks.safeExecResult.mockReturnValue({
      stdout:
        'fake/repo/node_modules/.pnpm/@openai+codex@0.146.0/node_modules/@openai/codex/bin/codex',
      stderr: '',
      status: 0,
    });

    expect(() =>
      resolveCodexBinary({ PATH: 'fake/repo/node_modules/.bin' } as NodeJS.ProcessEnv)
    ).toThrow(/KYBERION_CODEX_CLI_BIN/);
  });

  it('rejects Windows-style project-local shims without host paths', () => {
    mocks.safeExecResult.mockReturnValue({
      stdout: [
        String.raw`C:\repo\node_modules\.bin\codex`,
        String.raw`C:\repo\node_modules\@openai\codex\bin\codex`,
      ].join('\n'),
      stderr: '',
      status: 0,
    });
    expect(() =>
      resolveCodexBinary({ PATH: String.raw`C:\repo\node_modules\.bin` } as NodeJS.ProcessEnv)
    ).toThrow(/no acceptable Codex binary/);
  });

  it('rejects direct node_modules @openai/codex shims', () => {
    mocks.safeExecResult.mockReturnValue({
      stdout: 'fake/repo/node_modules/@openai/codex/bin/codex\nfake/system/codex',
      stderr: '',
      status: 0,
    });

    expect(
      resolveCodexBinary({ PATH: 'fake/repo/node_modules/.bin:fake/system' } as NodeJS.ProcessEnv)
    ).toBe('fake/system/codex');
  });

  it('normalizes mixed-case POSIX and Windows shim paths before matching', () => {
    mocks.safeExecResult.mockReturnValue({
      stdout: [
        'FAKE/REPO/Node_Modules/.BIN/COdEx',
        String.raw`C:\Fake\Repo\NODE_MODULES\@OPENAI\CODEX\BIN\CODEX`,
      ].join('\n'),
      stderr: '',
      status: 0,
    });

    expect(() =>
      resolveCodexBinary({ PATH: 'fake/repo/node_modules/.bin' } as NodeJS.ProcessEnv)
    ).toThrow(/no acceptable Codex binary/);
  });

  it('fails closed when stdout contains only shims even if resolver stderr is non-empty', () => {
    mocks.safeExecResult.mockReturnValue({
      stdout: 'fake/repo/node_modules/.bin/codex\n',
      stderr: 'which: codex: command not found\n/usr/local/bin/codex: diagnostic',
      status: 1,
    });

    expect(() =>
      resolveCodexBinary({ PATH: 'fake/repo/node_modules/.bin' } as NodeJS.ProcessEnv)
    ).toThrow(/Set KYBERION_CODEX_CLI_BIN to an explicit executable/);
  });

  describe('spawnCli env allowlisting (XP-02)', () => {
    const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const previousUnrelated = process.env.UNRELATED_TEST_SECRET;

    beforeEach(() => {
      mocks.safeWriteFile.mockReset();
      mocks.safeReadFile.mockReset().mockReturnValue(JSON.stringify({ ok: true }));
      mocks.safeRmSync.mockReset();
      mocks.spawnMock.mockReset();
    });

    afterEach(() => {
      if (previousAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
      if (previousUnrelated === undefined) delete process.env.UNRELATED_TEST_SECRET;
      else process.env.UNRELATED_TEST_SECRET = previousUnrelated;
    });

    it('spawns codex with an allowlisted env that excludes other providers credentials', async () => {
      process.env.ANTHROPIC_API_KEY = 'fake-anthropic-key-should-not-leak';
      process.env.UNRELATED_TEST_SECRET = 'should-not-leak-either';
      mocks.spawnMock.mockReturnValueOnce(createChild());

      await runCodexCliQuery({
        systemPrompt: 'sys',
        userPrompt: 'usr',
        schema: z.object({ ok: z.boolean() }),
        options: { bin: 'codex' },
      });

      expect(mocks.spawnMock).toHaveBeenCalledTimes(1);
      const [, , spawnOptions] = mocks.spawnMock.mock.calls[0];
      expect(spawnOptions.env.PATH).toBe(process.env.PATH);
      expect(spawnOptions.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(spawnOptions.env.UNRELATED_TEST_SECRET).toBeUndefined();
    });
  });

  describe('declarative permission profile argv (XP-02 follow-up)', () => {
    beforeEach(() => {
      mocks.safeWriteFile.mockReset();
      mocks.safeReadFile.mockReset().mockReturnValue(JSON.stringify({ ok: true }));
      mocks.safeRmSync.mockReset();
      mocks.spawnMock.mockReset();
    });

    it('no profile: argv is byte-identical to the mode-driven baseline', async () => {
      mocks.spawnMock.mockReturnValueOnce(createChild());

      await runCodexCliQuery({
        systemPrompt: 'sys',
        userPrompt: 'usr',
        schema: z.object({ ok: z.boolean() }),
        options: { bin: 'codex', model: 'codex-default', cwd: 'fake/workspace' },
      });

      expect(mocks.spawnMock).toHaveBeenCalledTimes(1);
      const [, argv] = mocks.spawnMock.mock.calls[0];
      // First four argv entries are the historical baseline: exec --sandbox <mode> --model <model>
      expect(argv.slice(0, 4)).toEqual(['exec', '--sandbox', 'read-only', '--model']);
    });

    it('explorer profile: argv contains the read-only sandbox mapping', async () => {
      mocks.spawnMock.mockReturnValueOnce(createChild());

      await runCodexCliQuery({
        systemPrompt: 'sys',
        userPrompt: 'usr',
        schema: z.object({ ok: z.boolean() }),
        profile: 'explorer',
        options: { bin: 'codex', model: 'codex-default', cwd: 'fake/workspace' },
      });

      expect(mocks.spawnMock).toHaveBeenCalledTimes(1);
      const [, argv] = mocks.spawnMock.mock.calls[0];
      expect(argv).toEqual(expect.arrayContaining(['--sandbox', 'read-only']));
      expect(argv).not.toContain('workspace-write');
    });

    it('planner profile: typed refusal, no spawn attempted', async () => {
      await expect(
        runCodexCliQuery({
          systemPrompt: 'sys',
          userPrompt: 'usr',
          schema: z.object({ ok: z.boolean() }),
          profile: 'planner',
          options: { bin: 'codex', model: 'codex-default', cwd: 'fake/workspace' },
        })
      ).rejects.toThrow(/permission profile "planner" refused/);

      expect(mocks.spawnMock).not.toHaveBeenCalled();
      expect(mocks.safeWriteFile).not.toHaveBeenCalled();
    });

    it('ambient read-only sandbox overrides a write-mode query before spawn', async () => {
      mocks.spawnMock.mockReturnValueOnce(createChild());
      const policy = resolveSandboxPolicy({
        provider: 'codex',
        mode: 'read-only',
        networkAccess: true,
      });

      await withSandboxPolicy(policy, () =>
        runCodexCliQuery({
          systemPrompt: 'sys',
          userPrompt: 'usr',
          schema: z.object({ ok: z.boolean() }),
          mode: 'workspace-write',
          options: { bin: 'codex', model: 'codex-default', cwd: 'fake/workspace' },
        })
      );

      const [, argv] = mocks.spawnMock.mock.calls[0];
      expect(argv).toEqual(expect.arrayContaining(['--sandbox', 'read-only']));
      expect(argv).not.toContain('workspace-write');
    });
  });

  describe('wall-clock budget wiring (XP-06)', () => {
    beforeEach(() => {
      mocks.safeWriteFile.mockReset();
      mocks.safeReadFile.mockReset().mockReturnValue(JSON.stringify({ ok: true }));
      mocks.safeRmSync.mockReset();
      mocks.spawnMock.mockReset();
      mocks.withWallClockBudgetMock.mockClear();
    });

    it('wraps the spawned child in withWallClockBudget with the codex provider and configured timeout', async () => {
      mocks.spawnMock.mockReturnValueOnce(createChild());

      await runCodexCliQuery({
        systemPrompt: 'sys',
        userPrompt: 'usr',
        schema: z.object({ ok: z.boolean() }),
        options: { bin: 'codex', model: 'codex-default', cwd: 'fake/workspace', timeoutMs: 54321 },
      });

      expect(mocks.withWallClockBudgetMock).toHaveBeenCalledTimes(1);
      const [opts, fn] = mocks.withWallClockBudgetMock.mock.calls[0];
      expect(opts).toMatchObject({ provider: 'codex', budgetMs: 54321 });
      expect(opts.child).toEqual(expect.objectContaining({ kill: expect.any(Function) }));
      expect(typeof fn).toBe('function');
    });
  });
});
