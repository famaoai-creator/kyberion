import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { z } from 'zod';
import {
  buildShellGrokCliBackendFromEnv,
  probeShellGrokCliAvailability,
  ShellGrokCliBackend,
} from './shell-grok-cli-backend.js';

const { spawnMock, withWallClockBudgetMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  withWallClockBudgetMock: vi.fn((_opts: unknown, fn: () => Promise<unknown>) => fn()),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

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
  child.pid = 4242;

  // Defer past the caller's listener registration (setImmediate > microtask).
  setImmediate(() => {
    child.stdout.write(stdoutText);
    child.stdout.end();
    child.stderr.end();
    child.emit('close', exitCode);
  });

  return child;
}

describe('shell-grok-cli-backend', () => {
  afterEach(() => {
    spawnMock.mockClear();
    withWallClockBudgetMock.mockClear();
  });

  it('returns null when the availability probe fails', () => {
    const backend = buildShellGrokCliBackendFromEnv(
      { KYBERION_GROK_CLI_BIN: 'grok' } as NodeJS.ProcessEnv,
      () => ({ available: false, reason: 'crash on launch' })
    );

    expect(backend).toBeNull();
  });

  it('can report a missing binary as unavailable', () => {
    const probe = probeShellGrokCliAvailability(
      { KYBERION_GROK_CLI_BIN: '__definitely_missing_binary__' } as NodeJS.ProcessEnv,
      { bin: '__definitely_missing_binary__', timeoutMs: 250 }
    );

    expect(probe.available).toBe(false);
    expect(probe.reason).toBeTruthy();
  });

  it('parses structuredOutput from the Grok JSON envelope', async () => {
    const envelope = JSON.stringify({
      text: '{"name":"kyberion","version":"1"}',
      structuredOutput: { name: 'kyberion', version: '1' },
      stopReason: 'EndTurn',
    });
    spawnMock.mockReturnValueOnce(createChild(envelope));

    const backend = new ShellGrokCliBackend({ bin: 'grok', model: 'grok-4.5' });
    const result = await backend.runStructured({
      systemPrompt: 'sys',
      userPrompt: 'user',
      schema: z.object({
        name: z.string(),
        version: z.string(),
      }),
    });

    expect(result).toEqual({ name: 'kyberion', version: '1' });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('-p');
    expect(args).toContain('--json-schema');
    expect(args).toContain('--system-prompt-override');
    expect(args).toContain('grok-4.5');
    expect(withWallClockBudgetMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'grok' }),
      expect.any(Function)
    );
  });

  it('falls back to parsing text when structuredOutput is absent', async () => {
    const envelope = JSON.stringify({
      text: '{"answer":"pong"}',
      stopReason: 'EndTurn',
    });
    spawnMock.mockReturnValueOnce(createChild(envelope));

    const backend = new ShellGrokCliBackend({ bin: 'grok' });
    const result = await backend.runStructured({
      systemPrompt: 'sys',
      userPrompt: 'user',
      schema: z.object({ answer: z.string() }),
    });
    expect(result).toEqual({ answer: 'pong' });
  });

  it('routes native delegation through the injected Grok ACP adopter session', async () => {
    const askNativeSubagent = vi.fn(async () => ({
      text: 'native grok result',
      stopReason: 'completed',
      metadata: {
        nativeSubagent: {
          provider: 'grok',
          parentThreadId: 'parent',
          threadId: 'parent',
          forked: false,
          mode: 'acp-native-subagent',
          effort: 'medium',
        },
      },
    }));
    const harnessSession = {
      boot: vi.fn(async () => undefined),
      ask: vi.fn(),
      askNativeSubagent,
      getRuntimeInfo: vi.fn(() => ({})),
    };
    const backend = new ShellGrokCliBackend({ harnessSession });
    const adopter = backend.getNativeSubagentAdopter?.();

    await expect(
      adopter?.dispatch('investigate', 'ctx', { profile: 'explorer', effort: 'medium' })
    ).resolves.toBe('native grok result');

    expect(harnessSession.boot).toHaveBeenCalledOnce();
    expect(askNativeSubagent).toHaveBeenCalledWith(
      expect.stringContaining('Task: investigate'),
      expect.objectContaining({ profile: 'explorer', subagent: true, effort: 'medium' })
    );
    expect(backend.requiresNativeSubagent?.()).toBe(true);
    expect(adopter?.id).toBe('grok-acp');
    expect(adopter?.getInfo?.()).toMatchObject({
      provider: 'grok',
      mode: 'acp-native-subagent',
    });
  });

  it('rejects a harness response that does not prove native delegation', async () => {
    const harnessSession = {
      boot: vi.fn(async () => undefined),
      ask: vi.fn(),
      askNativeSubagent: vi.fn(async () => ({ text: 'prompt-only', stopReason: 'completed' })),
    };
    const backend = new ShellGrokCliBackend({ harnessSession });

    await expect(backend.getNativeSubagentAdopter()?.dispatch('task')).rejects.toThrow(
      '[SUBAGENT_UNAVAILABLE] Grok ACP returned no native subagent metadata.'
    );
  });

  it('rejects an error stopReason as unavailable rather than a native result', async () => {
    const harnessSession = {
      boot: vi.fn(async () => undefined),
      ask: vi.fn(),
      askNativeSubagent: vi.fn(async () => ({
        text: 'boom',
        stopReason: 'error',
        metadata: { nativeSubagent: { provider: 'grok' } },
      })),
    };
    const backend = new ShellGrokCliBackend({ harnessSession });

    await expect(backend.getNativeSubagentAdopter()?.dispatch('task')).rejects.toThrow(
      '[SUBAGENT_UNAVAILABLE] Grok ACP returned an error response.'
    );
  });

  it('does not treat runtimeInfo as proof when the response has no native metadata', async () => {
    const harnessSession = {
      boot: vi.fn(async () => undefined),
      ask: vi.fn(),
      askNativeSubagent: vi.fn(async () => ({ text: 'parent-only', stopReason: 'completed' })),
      getRuntimeInfo: vi.fn(() => ({
        lastNativeSubagent: { provider: 'grok', mode: 'stale' },
      })),
    };
    const backend = new ShellGrokCliBackend({ harnessSession });

    await expect(backend.getNativeSubagentAdopter()?.dispatch('task')).rejects.toThrow(
      '[SUBAGENT_UNAVAILABLE] Grok ACP returned no native subagent metadata.'
    );
  });

  it('resets harness session on resetSession (QM-06)', async () => {
    const shutdownMock = vi.fn(async () => undefined);
    const harnessSession = {
      boot: vi.fn(async () => undefined),
      ask: vi.fn(),
      askNativeSubagent: vi.fn(async () => ({
        text: 'res',
        metadata: { nativeSubagent: { provider: 'grok' } },
      })),
      shutdown: shutdownMock,
    };
    const injected = new ShellGrokCliBackend({ harnessSession });
    await injected.resetSession();
    expect(shutdownMock).not.toHaveBeenCalled();

    const owned = new ShellGrokCliBackend({ bin: 'grok' });
    (owned as unknown as { harnessSession: { shutdown: () => Promise<void> } }).harnessSession = {
      shutdown: shutdownMock,
    };
    await owned.resetSession();
    expect(shutdownMock).toHaveBeenCalledTimes(1);
  });

  it('resets harnessBoot cache on boot rejection to allow subsequent retries', async () => {
    let bootCount = 0;
    const harnessSession = {
      boot: vi.fn(async () => {
        bootCount += 1;
        if (bootCount === 1) throw new Error('transient boot error');
      }),
      ask: vi.fn(),
      askNativeSubagent: vi.fn(async () => ({
        text: 'recovered',
        metadata: { nativeSubagent: { provider: 'grok' } },
      })),
    };
    const backend = new ShellGrokCliBackend({ harnessSession });
    const adopter = backend.getNativeSubagentAdopter();

    await expect(adopter.dispatch('task 1')).rejects.toThrow('transient boot error');
    await expect(adopter.dispatch('task 2')).resolves.toBe('recovered');
    expect(harnessSession.boot).toHaveBeenCalledTimes(2);
  });

  describe('spawnCli env allowlisting (XP-02)', () => {
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    const previousUnrelated = process.env.UNRELATED_TEST_SECRET;

    afterEach(() => {
      if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAiKey;
      if (previousUnrelated === undefined) delete process.env.UNRELATED_TEST_SECRET;
      else process.env.UNRELATED_TEST_SECRET = previousUnrelated;
    });

    it('spawns the CLI with an allowlisted env that excludes other providers credentials', async () => {
      process.env.OPENAI_API_KEY = 'fake-openai-key-should-not-leak';
      process.env.UNRELATED_TEST_SECRET = 'should-not-leak-either';
      spawnMock.mockReturnValueOnce(createChild('ok'));

      const backend = new ShellGrokCliBackend({ bin: 'grok' });
      await backend.delegateTask('do the thing');

      expect(spawnMock).toHaveBeenCalledTimes(1);
      const [, , spawnOptions] = spawnMock.mock.calls[0];
      expect(spawnOptions.env.PATH).toBe(process.env.PATH);
      expect(spawnOptions.env.OPENAI_API_KEY).toBeUndefined();
      expect(spawnOptions.env.UNRELATED_TEST_SECRET).toBeUndefined();
    });
  });
});
