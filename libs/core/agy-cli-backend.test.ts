import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { z } from 'zod';
import { pathResolver } from '@agent/core/path-resolver';
import { AgyCliBackend, buildAgyCliBackendFromEnv } from './agy-cli-backend.js';
import { AgySdkAdapter } from './agy-sdk-adapter.js';
import { resolveSandboxPolicy, withSandboxPolicy } from './sandbox-policy.js';

const { spawnMock, withWallClockBudgetMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  withWallClockBudgetMock: vi.fn((_opts: unknown, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

// XP-06: `spawnCli` now wraps its child in `withWallClockBudget`, which
// (unmocked) would persist a real active-child record via `secure-io` /
// `path-resolver` — a real filesystem write this suite must not perform.
// `delegation-concurrency.test.ts` owns the hermetic (temp-dir-backed) tests
// for the budget/kill machinery itself; here it's a spyable passthrough so
// every pre-existing assertion below is unaffected, while still letting this
// file assert *that* `spawnCli` wires through it with the right
// provider/budget.
vi.mock('./delegation-concurrency.js', () => ({
  delegationChildHandleFromChildProcess: (child: any) => ({
    pid: child.pid,
    kill: (signal: NodeJS.Signals) => child.kill(signal),
  }),
  withWallClockBudget: withWallClockBudgetMock,
  DelegationWallClockExceededError: class DelegationWallClockExceededError extends Error {},
  registerKillSwitchTerminationRegistrar: vi.fn(),
}));

function createChild(stdoutText: string, stderrText = '', exitCode = 0): any {
  const child = new EventEmitter() as any;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn();

  queueMicrotask(() => {
    if (stdoutText) child.stdout.write(stdoutText);
    child.stdout.end();
    if (stderrText) child.stderr.write(stderrText);
    child.stderr.end();
    child.emit('close', exitCode);
  });

  return child;
}

describe('agy-cli-backend', () => {
  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.KYBERION_AGY_CLI_BIN;
    delete process.env.KYBERION_AGY_CLI_MODEL;
    delete process.env.KYBERION_AGY_CLI_TIMEOUT_MS;
    delete process.env.KYBERION_AGY_CLI_LOG_FILE;
    delete process.env.KYBERION_AGY_SANDBOX;
    delete process.env.KYBERION_AGY_AGENT;
  });

  it('builds from env when agy cli settings are configured', () => {
    process.env.KYBERION_AGY_CLI_BIN = 'agy';
    process.env.KYBERION_AGY_CLI_MODEL = 'agy';
    process.env.KYBERION_AGY_SANDBOX = '1';

    const backend = buildAgyCliBackendFromEnv();

    expect(backend?.name).toBe('agy-cli');
  });

  it('routes the configured AGY CLI agent through the generated workspace definition', async () => {
    process.env.KYBERION_AGY_AGENT = 'kyberion-reviewer';
    const backend = buildAgyCliBackendFromEnv();
    spawnMock.mockReturnValue(createChild('{"response":"ok"}'));

    await backend?.prompt('hello');

    expect(spawnMock).toHaveBeenCalledWith(
      'agy',
      expect.arrayContaining(['--add-dir', pathResolver.rootDir(), '--agent', 'kyberion-reviewer']),
      expect.anything()
    );
  });

  it('passes configured Gemini 3.7 Flash model to AGY CLI invocation', async () => {
    process.env.KYBERION_AGY_CLI_MODEL = 'Gemini 3.7 Flash (Low)';
    const backend = buildAgyCliBackendFromEnv();
    spawnMock.mockReturnValue(createChild('{"response":"ok"}'));

    await backend?.prompt('analyze this');

    expect(spawnMock).toHaveBeenCalledWith(
      'agy',
      expect.arrayContaining(['--model', 'Gemini 3.7 Flash (Low)']),
      expect.anything()
    );
  });

  it('supports explicit gemini-3.7-flash in backend constructor options', async () => {
    const backend = new AgyCliBackend({ model: 'gemini-3.7-flash' });
    spawnMock.mockReturnValue(createChild('{"response":"ok"}'));

    await backend.prompt('test run');

    expect(spawnMock).toHaveBeenCalledWith(
      'agy',
      expect.arrayContaining(['--model', 'gemini-3.7-flash']),
      expect.anything()
    );
  });

  it('rejects dangerous keys in structured AGY CLI output before schema access', async () => {
    spawnMock.mockReturnValueOnce(
      createChild('{"structured_output":{"constructor":{"polluted":true}}}')
    );

    const backend = new AgyCliBackend({ model: 'agy' });

    await expect(
      backend.runStructured({
        systemPrompt: 'Return a result.',
        userPrompt: 'hello',
        schema: z.object({ answer: z.string() }),
      })
    ).rejects.toThrow('agy-cli JSON output contains a dangerous JSON key');
  });

  it('exposes a valid native subagent adopter via AGY session harness', async () => {
    const fakeHarness = {
      boot: vi.fn(async () => {}),
      ask: vi.fn(async () => ({ text: 'fake' })),
      askNativeSubagent: vi.fn(async (prompt: string, options: Record<string, unknown>) => ({
        text: `delegated: ${prompt}`,
        metadata: {
          nativeSubagent: {
            provider: 'agy',
            threadId: 'agy-session-123',
            mode: 'agy-subagent-adopter',
          },
        },
      })),
      getRuntimeInfo: () => ({
        lastNativeSubagent: { provider: 'agy', threadId: 'agy-session-123' },
      }),
    };

    const backend = new AgyCliBackend({ bin: 'agy', model: 'agy', harnessSession: fakeHarness });
    const adopter = backend.getNativeSubagentAdopter?.();

    expect(adopter?.id).toBe('agy-cli');
    expect(backend.requiresNativeSubagent?.()).toBe(true);

    const result = await adopter?.dispatch('native task', 'ctx');
    expect(result).toContain('delegated:');
    expect(fakeHarness.askNativeSubagent).toHaveBeenCalledTimes(1);
    expect(fakeHarness.askNativeSubagent).toHaveBeenCalledWith(
      expect.stringContaining('Task: native task'),
      expect.objectContaining({ profile: 'implementer', subagent: true, effort: 'medium' })
    );
    expect(adopter?.getInfo?.()).toMatchObject({
      provider: 'agy',
      threadId: 'agy-session-123',
    });
  });

  it('rejects a harness response that does not prove native delegation', async () => {
    const fakeHarness = {
      boot: vi.fn(async () => {}),
      ask: vi.fn(async () => ({ text: 'fake' })),
      askNativeSubagent: vi.fn(async () => ({ text: 'prompt-only', stopReason: 'completed' })),
    };
    const backend = new AgyCliBackend({ harnessSession: fakeHarness });

    await expect(backend.getNativeSubagentAdopter()?.dispatch('task')).rejects.toThrow(
      '[SUBAGENT_UNAVAILABLE] AGY SDK returned no native subagent metadata.'
    );
  });

  it('resets harness session on resetSession (QM-06)', async () => {
    const shutdownMock = vi.fn(async () => {});
    const fakeHarness = {
      boot: vi.fn(async () => {}),
      ask: vi.fn(async () => ({ text: 'fake' })),
      askNativeSubagent: vi.fn(async () => ({ text: 'res', metadata: { nativeSubagent: {} } })),
      shutdown: shutdownMock,
    };
    const backend = new AgyCliBackend({ harnessSession: fakeHarness });
    await backend.resetSession();
    expect(shutdownMock).not.toHaveBeenCalled(); // Injected harness session is not shut down

    // Non-injected harness session shutdown test
    const customBackend = new AgyCliBackend({ bin: 'agy' });
    (customBackend as any).harnessSession = { shutdown: shutdownMock };
    await customBackend.resetSession();
    expect(shutdownMock).toHaveBeenCalledTimes(1);
  });

  it('resets harnessBoot cache on boot rejection to allow subsequent retries', async () => {
    let bootCount = 0;
    const fakeHarness = {
      boot: vi.fn(async () => {
        bootCount++;
        if (bootCount === 1) throw new Error('transient boot error');
      }),
      ask: vi.fn(async () => ({ text: 'fake' })),
      askNativeSubagent: vi.fn(async () => ({
        text: 'recovered',
        metadata: { nativeSubagent: { provider: 'agy' } },
      })),
    };
    const backend = new AgyCliBackend({ harnessSession: fakeHarness });
    const adopter = backend.getNativeSubagentAdopter();

    await expect(adopter.dispatch('task 1')).rejects.toThrow('transient boot error');
    // Second attempt should re-try boot() instead of re-awaiting cached rejection
    const result = await adopter.dispatch('task 2');
    expect(result).toBe('recovered');
    expect(fakeHarness.boot).toHaveBeenCalledTimes(2);
  });

  it('runs print mode with the current agy cli flags and parses JSON output', async () => {
    spawnMock.mockReturnValueOnce(createChild(JSON.stringify({ response: '{"ok":true}' })));

    const backend = new AgyCliBackend({
      bin: 'agy',
      model: 'agy',
      sandbox: true,
      logFile: '/tmp/agy-cli.log',
    });

    const result = await backend.prompt('Return JSON: {"ok":true}');

    expect(result).toBe('{"ok":true}');
    expect(spawnMock).toHaveBeenCalledWith(
      'agy',
      expect.arrayContaining([
        '--log-file',
        '/tmp/agy-cli.log',
        '--model',
        'agy',
        '--add-dir',
        pathResolver.rootDir(),
        '--sandbox',
        '--dangerously-skip-permissions',
        '-p',
        'Return JSON: {"ok":true}',
      ]),
      expect.any(Object)
    );
    expect(spawnMock.mock.calls[0][1]).not.toContain('--output-format');
    expect(spawnMock.mock.calls[0][1]).not.toContain('--json-schema');
    expect(spawnMock.mock.calls[0][1]).not.toContain('--system-prompt');
  });

  describe('spawnCli env allowlisting (XP-02)', () => {
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
    const previousUnrelated = process.env.UNRELATED_TEST_SECRET;

    afterEach(() => {
      if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAiKey;
      if (previousAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
      if (previousUnrelated === undefined) delete process.env.UNRELATED_TEST_SECRET;
      else process.env.UNRELATED_TEST_SECRET = previousUnrelated;
    });

    it('spawns agy with an allowlisted env that excludes other providers credentials', async () => {
      process.env.OPENAI_API_KEY = 'fake-openai-key-should-not-leak';
      process.env.ANTHROPIC_API_KEY = 'fake-anthropic-key-should-not-leak';
      process.env.UNRELATED_TEST_SECRET = 'should-not-leak-either';
      spawnMock.mockReturnValueOnce(createChild(JSON.stringify({ response: 'ok' })));

      const backend = new AgyCliBackend({
        bin: 'agy',
        model: 'agy',
        sandbox: true,
        logFile: '/tmp/agy-cli.log',
      });
      await backend.prompt('hello');

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [, , spawnOptions] = spawnMock.mock.calls[0];
      expect(spawnOptions.env.PATH).toBe(process.env.PATH);
      expect(spawnOptions.env.OPENAI_API_KEY).toBeUndefined();
      expect(spawnOptions.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(spawnOptions.env.UNRELATED_TEST_SECRET).toBeUndefined();
    });
  });

  describe('declarative permission profile argv (XP-02 follow-up)', () => {
    afterEach(() => {
      spawnMock.mockClear();
    });

    it('no profile: argv is byte-identical to the pre-profile baseline (sandbox + skip-permissions)', async () => {
      spawnMock.mockReturnValueOnce(createChild(JSON.stringify({ response: 'ok' })));

      const backend = new AgyCliBackend({
        bin: 'agy',
        model: 'agy',
        sandbox: true,
        logFile: '/tmp/agy-cli.log',
      });
      await backend.prompt('hello');

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [, argv] = spawnMock.mock.calls[0];
      expect(argv).toEqual([
        '--log-file',
        '/tmp/agy-cli.log',
        '--model',
        'agy',
        '--add-dir',
        pathResolver.rootDir(),
        '--sandbox',
        '--dangerously-skip-permissions',
        '-p',
        'hello',
      ]);
    });

    it('selects a generated Kyberion AGY agent when requested', async () => {
      spawnMock.mockReturnValueOnce(createChild(JSON.stringify({ response: 'ok' })));

      const backend = new AgyCliBackend({
        bin: 'agy',
        model: 'agy',
        agent: 'kyberion-reviewer',
        workspaceDir: '/workspace/kyberion',
        logFile: '/tmp/agy-cli.log',
      });
      await backend.prompt('hello');

      const [, argv] = spawnMock.mock.calls[0];
      expect(argv).toEqual(
        expect.arrayContaining(['--add-dir', '/workspace/kyberion', '--agent', 'kyberion-reviewer'])
      );
    });

    it('can disable workspace customization discovery for an external AGY workspace', async () => {
      spawnMock.mockReturnValueOnce(createChild(JSON.stringify({ response: 'ok' })));

      const backend = new AgyCliBackend({
        bin: 'agy',
        model: 'agy',
        includeWorkspaceAgents: false,
        logFile: '/tmp/agy-cli.log',
      });
      await backend.prompt('hello');

      const [, argv] = spawnMock.mock.calls[0];
      expect(argv).not.toContain('--add-dir');
    });

    it('explorer profile is refused until AGY exposes a verified read-only sandbox', async () => {
      const backend = new AgyCliBackend({
        bin: 'agy',
        model: 'agy',
        sandbox: true,
        logFile: '/tmp/agy-cli.log',
      });
      await expect(backend.prompt('hello', { profile: 'explorer' })).rejects.toThrow(
        /permission profile "explorer" refused/
      );
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('ambient read-only sandbox refuses before an unprofiled AGY delegation can spawn', async () => {
      const backend = new AgyCliBackend({
        bin: 'agy',
        model: 'agy',
        sandbox: true,
        logFile: '/tmp/agy-cli.log',
      });
      const policy = resolveSandboxPolicy({
        provider: 'agy',
        mode: 'read-only',
        networkAccess: true,
      });

      await expect(
        withSandboxPolicy(policy, () => backend.prompt('inspect the thing'))
      ).rejects.toThrow('SANDBOX_POLICY_PARTIAL');
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('reviewer team role is refused under AGY until read-only mode is verified', async () => {
      const backend = new AgyCliBackend({
        bin: 'agy',
        model: 'agy',
        sandbox: true,
        logFile: '/tmp/agy-cli.log',
      });
      await expect(backend.prompt('hello', { role: 'reviewer' })).rejects.toThrow(
        /permission profile "explorer" refused/
      );
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('unknown role or profile fails closed through the explorer tier', async () => {
      const backend = new AgyCliBackend({
        bin: 'agy',
        model: 'agy',
        sandbox: true,
        logFile: '/tmp/agy-cli.log',
      });
      await expect(backend.prompt('hello', { role: 'unknown_custom_role' })).rejects.toThrow(
        /permission profile "explorer" refused/
      );
      expect(spawnMock).not.toHaveBeenCalled();
    });

    it('planner profile: typed refusal, no spawn attempted', async () => {
      const backend = new AgyCliBackend({
        bin: 'agy',
        model: 'agy',
        sandbox: true,
        logFile: '/tmp/agy-cli.log',
      });

      await expect(backend.prompt('hello', { profile: 'planner' })).rejects.toThrow(
        /permission profile "planner" refused/
      );
      expect(spawnMock).not.toHaveBeenCalled();
    });
  });

  it('runs structured mode by requesting json in the prompt and validates the response', async () => {
    spawnMock.mockReturnValueOnce(
      createChild(
        '```json\n{"goal":"ship","constraints":[],"deliverables":[],"excluded":[],"stakeholders":[]}\n```'
      )
    );

    const backend = new AgyCliBackend({
      bin: 'agy',
      model: 'agy',
      sandbox: true,
      logFile: '/tmp/agy-cli.log',
    });

    const result = await backend.runStructured({
      systemPrompt: 'Extract intent.',
      userPrompt: 'please ship this',
      schema: z.object({
        goal: z.string(),
        constraints: z.array(z.string()),
        deliverables: z.array(z.string()),
        excluded: z.array(z.string()),
        stakeholders: z.array(z.string()),
      }),
    });

    expect(result).toMatchObject({ goal: 'ship' });
  });

  describe('wall-clock budget wiring (XP-06)', () => {
    it('wraps the spawned child in withWallClockBudget with the agy provider and configured timeout', async () => {
      spawnMock.mockReturnValueOnce(createChild(JSON.stringify({ response: 'ok' })));

      const backend = new AgyCliBackend({ bin: 'agy', model: 'agy', timeoutMs: 9876 });
      const controller = new AbortController();
      await backend.delegateTask('hello', undefined, { signal: controller.signal });

      expect(withWallClockBudgetMock).toHaveBeenCalledTimes(1);
      const [opts, fn] = withWallClockBudgetMock.mock.calls[0];
      expect(opts).toMatchObject({ provider: 'agy', budgetMs: 9876 });
      expect(opts.signal).toBe(controller.signal);
      expect(opts.child).toEqual(expect.objectContaining({ kill: expect.any(Function) }));
      expect(typeof fn).toBe('function');
    });
  });

  describe('AgySdkAdapter lifecycle resilience (P1 & P2 fixes)', () => {
    it('clears bootPromise on failure to allow subsequent boot retries', async () => {
      let attempts = 0;
      const fakeSpawn = vi.fn(() => {
        attempts++;
        const child = new EventEmitter() as any;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new PassThrough();
        child.killed = false;
        child.exitCode = null;
        child.kill = vi.fn(() => {
          child.killed = true;
          child.exitCode = 1;
          child.emit('close', 1, null);
        });

        queueMicrotask(() => {
          if (attempts === 1) {
            child.emit('error', new Error('boot process error'));
          } else {
            child.stdout.write(JSON.stringify({ event: 'ready' }) + '\n');
          }
        });
        return child;
      });

      const adapter = new AgySdkAdapter({ spawnProcess: fakeSpawn as any });

      await expect(adapter.boot()).rejects.toThrow('boot process error');

      // Second attempt should re-trigger boot() rather than returning rejected Promise
      await expect(adapter.boot()).resolves.toBeUndefined();
      expect(fakeSpawn).toHaveBeenCalledTimes(2);
    });

    it('resets bootPromise and process state after a booted bridge process exits, enabling automatic re-spawning on subsequent boot()', async () => {
      let attempts = 0;
      let activeChild: any;
      const fakeSpawn = vi.fn(() => {
        attempts++;
        const child = new EventEmitter() as any;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new PassThrough();
        child.killed = false;
        child.exitCode = null;
        activeChild = child;

        queueMicrotask(() => {
          child.stdout.write(JSON.stringify({ event: 'ready' }) + '\n');
        });
        return child;
      });

      const adapter = new AgySdkAdapter({ spawnProcess: fakeSpawn as any });

      // First boot succeeds
      await adapter.boot();
      expect(fakeSpawn).toHaveBeenCalledTimes(1);

      // Simulate bridge process exiting abnormally
      activeChild.exitCode = 1;
      activeChild.emit('close', 1, null);

      // Subsequent boot must spawn a new bridge process (spawnCount: 2)
      await adapter.boot();
      expect(fakeSpawn).toHaveBeenCalledTimes(2);
    });

    it('does not reject pending requests of a new bridge process when a stale bridge process emits a delayed close event', async () => {
      let attempts = 0;
      let firstChild: any;
      let secondChild: any;

      const fakeSpawn = vi.fn(() => {
        attempts++;
        const child = new EventEmitter() as any;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new PassThrough();
        child.killed = false;
        child.exitCode = null;

        if (attempts === 1) {
          firstChild = child;
        } else {
          secondChild = child;
        }

        queueMicrotask(() => {
          child.stdout.write(JSON.stringify({ event: 'ready' }) + '\n');
        });
        return child;
      });

      const adapter = new AgySdkAdapter({ spawnProcess: fakeSpawn as any });

      // First boot
      await adapter.boot();

      // First bridge process exits
      firstChild.exitCode = 1;
      firstChild.emit('close', 1, null);

      // Re-boot spawns second bridge
      await adapter.boot();
      expect(fakeSpawn).toHaveBeenCalledTimes(2);

      // Start an askNativeSubagent request on second bridge
      const askPromise = adapter.askNativeSubagent('test prompt');

      // Stale firstChild now emits a delayed close event
      firstChild.emit('close', 1, null);

      queueMicrotask(() => {
        secondChild.stdout.write(
          JSON.stringify({ id: 'agy-sdk-1', ok: true, text: 'success response' }) + '\n'
        );
      });

      // The request on secondChild should resolve cleanly without being rejected by firstChild close
      const res = await askPromise;
      expect(res.text).toBe('success response');
    });

    it('shutdown closes stdin and awaits process exit cleanly', async () => {
      const child = new EventEmitter() as any;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.killed = false;
      child.exitCode = null;
      const originalEnd = child.stdin.end.bind(child.stdin);
      child.stdin.end = vi.fn((...args: any[]) => {
        originalEnd(...args);
        child.killed = true;
        child.exitCode = 0;
        queueMicrotask(() => child.emit('close', 0, null));
      });
      child.kill = vi.fn(() => {
        child.killed = true;
        child.exitCode = 0;
        child.emit('close', 0, null);
      });

      const fakeSpawn = vi.fn(() => child);
      const adapter = new AgySdkAdapter({ spawnProcess: fakeSpawn as any });

      queueMicrotask(() => {
        child.stdout.write(JSON.stringify({ event: 'ready' }) + '\n');
      });
      await adapter.boot();

      await adapter.shutdown();

      expect(child.stdin.end).toHaveBeenCalled();
    });

    it('rejects an in-flight boot when shutdown is requested before readiness', async () => {
      const child = new EventEmitter() as any;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.exitCode = null;
      child.signalCode = null;
      child.kill = vi.fn(() => {
        child.exitCode = 1;
        child.emit('close', 1, null);
      });

      const adapter = new AgySdkAdapter({ spawnProcess: vi.fn(() => child) as any });
      const boot = adapter.boot();
      const shutdown = adapter.shutdown();

      const result = await Promise.race([
        boot.then(
          () => 'fulfilled',
          (error) => error.message
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve('still-pending'), 100)),
      ]);

      expect(result).toContain('shut down during boot');
      await shutdown;
    });
  });
});
