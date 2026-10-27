import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { z } from 'zod';
import {
  buildCodexCliQueryOptionsFromEnv,
  resolveCodexBinary,
  runCodexCliQuery,
} from './codex-cli-query.js';
import { resolveSandboxPolicy, withSandboxPolicy } from '../shell/sandbox-policy.js';
import { metrics } from '../metrics.js';

beforeEach(() => {
  vi.spyOn(metrics, 'record').mockImplementation(() => undefined as never);
});

const mocks = vi.hoisted(() => ({
  safeExecResult: vi.fn(),
  safeLstat: vi.fn(() => ({ isFile: () => true })),
  safeWriteFile: vi.fn(),
  safeReadFile: vi.fn(),
  safeRmSync: vi.fn(),
  spawnMock: vi.fn(),
  withWallClockBudgetMock: vi.fn((_opts: unknown, fn: () => Promise<unknown>) => fn()),
  prepareSessionGitIndex: vi.fn(),
  sessionIndexDispose: vi.fn(),
}));

// WS-02: the private git index is stubbed so no real index is ever copied.
const isProviderDescriptorPath = vi.hoisted(
  () => (filePath: string) => /[\\/]reasoning-providers[\\/][^\\/]+\.json$/u.test(String(filePath))
);

vi.mock('../session-git-index.js', () => ({
  prepareSessionGitIndex: mocks.prepareSessionGitIndex,
}));

vi.mock('../secure-io.js', async () => {
  const actual = await vi.importActual<typeof import('../secure-io.js')>('../secure-io.js');
  return {
    ...actual,
    safeExecResult: mocks.safeExecResult,
    safeLstat: mocks.safeLstat,
    safeWriteFile: mocks.safeWriteFile,
    // Provider permission projections are descriptor data
    // (reasoning-providers/*.json); keep those governed reads real.
    safeReadFile: ((filePath: string, options?: unknown) =>
      isProviderDescriptorPath(filePath)
        ? actual.safeReadFile(filePath, options as never)
        : mocks.safeReadFile(filePath, options)) as typeof actual.safeReadFile,
    safeRmSync: mocks.safeRmSync,
  };
});

vi.mock('../foundation/text.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../foundation/text.js')>();
  return {
    ...actual,
    readTextFile: (filePath: string) =>
      isProviderDescriptorPath(filePath)
        ? actual.readTextFile(filePath)
        : mocks.safeReadFile(filePath),
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
vi.mock('../mission/delegation-concurrency.js', () => ({
  delegationChildHandleFromChildProcess: (child: any) => ({
    pid: child.pid,
    kill: (signal: NodeJS.Signals) => child.kill(signal),
  }),
  withWallClockBudget: mocks.withWallClockBudgetMock,
  DelegationWallClockExceededError: class DelegationWallClockExceededError extends Error {},
}));

function createChild(exitCode = 0, stdoutText = ''): any {
  const child = new EventEmitter() as any;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn();

  queueMicrotask(() => {
    if (stdoutText) child.stdout.write(stdoutText);
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

  it('reads actual usage from the JSONL transport while validating only the output file', async () => {
    mocks.safeReadFile.mockReturnValue(JSON.stringify({ ok: true }));
    mocks.spawnMock.mockReturnValueOnce(
      createChild(
        0,
        JSON.stringify({
          type: 'turn.completed',
          usage: { input_tokens: 120, cached_input_tokens: 80, output_tokens: 10 },
        })
      )
    );
    const result = await runCodexCliQuery({
      systemPrompt: 'sys',
      userPrompt: 'usr',
      schema: z.object({ ok: z.boolean() }),
      options: { bin: 'codex' },
    });
    expect(result).toEqual({ ok: true });
    expect(mocks.spawnMock.mock.calls[0][1]).toContain('--json');
    expect(metrics.record).toHaveBeenCalledTimes(1);
    expect(vi.mocked(metrics.record).mock.calls[0][3]).toMatchObject({
      usage_source: 'provider',
      billing_mode: 'unknown',
      usage: { prompt_tokens: 40, cache_read_tokens: 80, completion_tokens: 10 },
    });
  });

  it('keeps a missing CLI binary unpriced instead of charging the prompt estimate', async () => {
    const child = new EventEmitter() as any;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = vi.fn();
    mocks.spawnMock.mockReturnValueOnce(child);
    queueMicrotask(() => child.emit('error', new Error('ENOENT')));
    await expect(
      runCodexCliQuery({
        systemPrompt: 'sys',
        userPrompt: 'usr',
        schema: z.object({ ok: z.boolean() }),
        options: { bin: 'codex' },
      })
    ).rejects.toThrow('spawn failed');
    expect(metrics.record).not.toHaveBeenCalled();
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

  it('loads the isolated account profile from the governed environment', () => {
    const options = buildCodexCliQueryOptionsFromEnv({
      PATH: '/usr/bin',
      KYBERION_CODEX_PROFILE: 'work',
    } as NodeJS.ProcessEnv);
    expect(options.codexProfile).toBe('work');
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
      mocks.safeLstat.mockReset().mockReturnValue({ isFile: () => true });
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

    it('projects a low reasoning effort onto the Codex CLI config override', async () => {
      mocks.spawnMock.mockReturnValueOnce(createChild());

      await runCodexCliQuery({
        systemPrompt: 'sys',
        userPrompt: 'usr',
        schema: z.object({ ok: z.boolean() }),
        options: { bin: 'codex', model: 'gpt-5.6-luna', effort: 'low' },
      });

      const [, argv] = mocks.spawnMock.mock.calls[0];
      expect(argv).toEqual(expect.arrayContaining(['--model', 'gpt-5.6-luna']));
      expect(argv).toEqual(expect.arrayContaining(['-c', 'model_reasoning_effort=low']));
    });

    const wideningExtras = [
      '--sandbox',
      'workspace-write',
      '-s',
      'danger-full-access',
      '--dangerously-bypass-approvals-and-sandbox',
      '--full-auto',
      '--add-dir',
      '/elsewhere',
      '-c',
      'sandbox_mode=danger-full-access',
      '--config=approval_policy=never',
      '-c',
      'model_verbosity=low',
    ];

    it('strips widening extras when a permission profile is requested', async () => {
      mocks.spawnMock.mockReturnValueOnce(createChild());

      await runCodexCliQuery({
        systemPrompt: 'sys',
        userPrompt: 'usr',
        schema: z.object({ ok: z.boolean() }),
        profile: 'explorer',
        options: { bin: 'codex', extraArgs: wideningExtras },
      });

      const [, argv] = mocks.spawnMock.mock.calls[0] as [string, string[]];
      expect(argv.slice(1, 3)).toEqual(['--sandbox', 'read-only']);
      expect(argv.filter((arg) => arg === '--sandbox')).toHaveLength(1);
      for (const widened of [
        'workspace-write',
        'danger-full-access',
        '--dangerously-bypass-approvals-and-sandbox',
        '--full-auto',
        '--add-dir',
        'sandbox_mode=danger-full-access',
        '--config=approval_policy=never',
      ]) {
        expect(argv).not.toContain(widened);
      }
      expect(argv).toEqual(expect.arrayContaining(['-c', 'model_verbosity=low']));
    });

    it('keeps caller extras unchanged without a permission profile', async () => {
      mocks.spawnMock.mockReturnValueOnce(createChild());

      await runCodexCliQuery({
        systemPrompt: 'sys',
        userPrompt: 'usr',
        schema: z.object({ ok: z.boolean() }),
        options: { bin: 'codex', extraArgs: ['--full-auto'] },
      });

      const [, argv] = mocks.spawnMock.mock.calls[0] as [string, string[]];
      expect(argv).toContain('--full-auto');
    });
  });

  describe('private session git index (WS-02)', () => {
    beforeEach(() => {
      vi.stubEnv('KYBERION_SESSION_GIT_INDEX', '1');
      mocks.safeReadFile.mockReset().mockReturnValue(JSON.stringify({ ok: true }));
      mocks.safeLstat.mockReset().mockReturnValue({ isFile: () => true });
      mocks.spawnMock.mockReset();
      mocks.sessionIndexDispose.mockReset();
      mocks.prepareSessionGitIndex.mockReset().mockImplementation(({ sessionId }) => ({
        sessionId,
        env: { GIT_INDEX_FILE: `/private/${sessionId}/index` },
        dispose: mocks.sessionIndexDispose,
      }));
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('workspace-write runs get a private GIT_INDEX_FILE in the query cwd, disposed on close', async () => {
      mocks.spawnMock.mockReturnValueOnce(createChild());

      await runCodexCliQuery({
        systemPrompt: 'sys',
        userPrompt: 'usr',
        schema: z.object({ ok: z.boolean() }),
        mode: 'workspace-write',
        options: { bin: 'codex', cwd: 'fake/workspace' },
      });

      const [{ sessionId, cwd }] = mocks.prepareSessionGitIndex.mock.calls[0];
      expect(sessionId).toMatch(/^codex-/);
      expect(cwd).toBe('fake/workspace');
      const [, , spawnOptions] = mocks.spawnMock.mock.calls[0];
      expect(spawnOptions.env.GIT_INDEX_FILE).toBe(`/private/${sessionId}/index`);
      expect(mocks.sessionIndexDispose).toHaveBeenCalled();
    });

    it('disposes the private index when spawn throws synchronously', async () => {
      mocks.spawnMock.mockImplementationOnce(() => {
        throw new Error('spawn EACCES');
      });

      await expect(
        runCodexCliQuery({
          systemPrompt: 'sys',
          userPrompt: 'usr',
          schema: z.object({ ok: z.boolean() }),
          mode: 'workspace-write',
          options: { bin: 'codex', cwd: 'fake/workspace' },
        })
      ).rejects.toThrow('spawn EACCES');
      expect(mocks.prepareSessionGitIndex).toHaveBeenCalledTimes(1);
      expect(mocks.sessionIndexDispose).toHaveBeenCalledTimes(1);
    });

    it('read-only runs get no private index', async () => {
      mocks.spawnMock.mockReturnValueOnce(createChild());

      await runCodexCliQuery({
        systemPrompt: 'sys',
        userPrompt: 'usr',
        schema: z.object({ ok: z.boolean() }),
        options: { bin: 'codex' },
      });

      const [, , spawnOptions] = mocks.spawnMock.mock.calls[0];
      expect(spawnOptions.env.GIT_INDEX_FILE).toBeUndefined();
      expect(mocks.prepareSessionGitIndex).not.toHaveBeenCalled();
    });

    it('KYBERION_SESSION_GIT_INDEX=0 keeps implementer runs on the shared index', async () => {
      vi.stubEnv('KYBERION_SESSION_GIT_INDEX', '0');
      mocks.spawnMock.mockReturnValueOnce(createChild());

      await runCodexCliQuery({
        systemPrompt: 'sys',
        userPrompt: 'usr',
        schema: z.object({ ok: z.boolean() }),
        profile: 'implementer',
        options: { bin: 'codex' },
      });

      const [, , spawnOptions] = mocks.spawnMock.mock.calls[0];
      expect(spawnOptions.env.GIT_INDEX_FILE).toBeUndefined();
      expect(mocks.prepareSessionGitIndex).not.toHaveBeenCalled();
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

    it('carries a configured auxiliary CLI bundle deadline to the spawned request', async () => {
      await import('./bundles/codex-cli.js');
      const { buildCliProviderBundle } = await import('../cli-provider-bundle.js');
      mocks.safeReadFile.mockReturnValue(JSON.stringify({ answer: 'compact result' }));
      mocks.spawnMock.mockReturnValueOnce(createChild());
      const bundle = buildCliProviderBundle({
        mode: 'codex-cli',
        provider: 'codex',
        model: 'codex-default',
        timeoutMs: 1234,
        env: {},
      });
      const controller = new AbortController();
      await expect(
        bundle!.backend.backend.prompt('compact', {
          role: 'context_compaction',
          signal: controller.signal,
        })
      ).resolves.toBe('compact result');
      expect(mocks.withWallClockBudgetMock).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'codex', budgetMs: 1234, signal: controller.signal }),
        expect.any(Function)
      );
      expect(mocks.spawnMock).toHaveBeenCalledTimes(1);
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

    it('fails closed when the CLI output path is not a regular file', async () => {
      mocks.spawnMock.mockReturnValueOnce(createChild());
      mocks.safeLstat.mockImplementation((filePath: string) => ({
        isFile: () => !filePath.includes('kyberion-codex-output-'),
      }));

      await expect(
        runCodexCliQuery({
          systemPrompt: 'sys',
          userPrompt: 'usr',
          schema: z.object({ ok: z.boolean() }),
          options: { bin: 'codex' },
        })
      ).rejects.toThrow(/structured output must be a regular file/);
      expect(mocks.safeReadFile).not.toHaveBeenCalled();
    });
  });
});

describe('stripNullObjectProperties (nullable-optional inverse)', () => {
  it('removes null-valued properties recursively and lets an optional zod field pass', async () => {
    const { stripNullObjectProperties } = await import('./codex-cli-query.js');
    const schema = z.object({
      title: z.string(),
      experience: z.object({ cue: z.string() }).optional(),
      edit_rows: z.array(z.object({ component: z.string() })).optional(),
    });
    const declined = { title: 't', experience: null, edit_rows: null };
    expect(schema.safeParse(declined).success).toBe(false);
    expect(schema.safeParse(stripNullObjectProperties(declined)).success).toBe(true);
    // Present values survive; nested nulls inside kept objects are stripped too.
    expect(stripNullObjectProperties({ a: { b: null, c: 1 }, d: [{ e: null }, null] })).toEqual({
      a: { c: 1 },
      d: [{}, null],
    });
  });

  it('does not rescue a genuinely required nullable field returning the wrong type', async () => {
    const { stripNullObjectProperties } = await import('./codex-cli-query.js');
    const schema = z.object({ v: z.union([z.string(), z.null()]) });
    // Required-but-nullable: real null parses on the first pass, unchanged path.
    expect(schema.safeParse({ v: null }).success).toBe(true);
    // A wrong type still fails even after stripping.
    expect(schema.safeParse(stripNullObjectProperties({ v: 42 })).success).toBe(false);
  });
});
