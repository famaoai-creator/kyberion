import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { z } from 'zod';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import {
  buildCursorCliBackendFromEnv,
  CursorCliReasoningBackend,
  probeCursorCliAvailability,
  resolveCursorModelForTier,
} from './cursor-cli-reasoning-backend.js';
import { resolveSandboxPolicy, withSandboxPolicy } from './sandbox-policy.js';

const { spawnMock, withWallClockBudgetMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  withWallClockBudgetMock: vi.fn((_opts: unknown, fn: () => Promise<unknown>) => fn()),
}));

interface MockChildProcess extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  kill: (signal: NodeJS.Signals) => void;
  pid: number;
}

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

vi.mock('./delegation-concurrency.js', () => ({
  delegationChildHandleFromChildProcess: (child: MockChildProcess) => ({
    pid: child.pid,
    kill: (signal: NodeJS.Signals) => child.kill(signal),
  }),
  withWallClockBudget: withWallClockBudgetMock,
  DelegationWallClockExceededError: class DelegationWallClockExceededError extends Error {},
}));

function createChild(stdoutText: string, exitCode = 0): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn();
  child.pid = 4242;

  setImmediate(() => {
    child.stdout.write(stdoutText);
    child.stdout.end();
    child.stderr.end();
    child.emit('close', exitCode);
  });

  return child;
}

describe('cursor-cli-reasoning-backend', () => {
  it('routes Cursor CLI environment reads through the governed accessor', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('libs/core/cursor-cli-reasoning-backend.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toMatch(/env\.KYBERION_/u);
    expect(source).toContain('getRegisteredEnvText');
  });

  afterEach(() => {
    spawnMock.mockClear();
    withWallClockBudgetMock.mockClear();
  });

  it('returns null when the availability probe fails', () => {
    const backend = buildCursorCliBackendFromEnv(
      { KYBERION_CURSOR_CLI_BIN: 'cursor-agent' } as NodeJS.ProcessEnv,
      () => ({ available: false, reason: 'crash on launch' })
    );

    expect(backend).toBeNull();
  });

  it('can report a missing binary as unavailable', () => {
    const probe = probeCursorCliAvailability(
      { KYBERION_CURSOR_CLI_BIN: '__definitely_missing_binary__' } as NodeJS.ProcessEnv,
      { bin: '__definitely_missing_binary__', timeoutMs: 250 }
    );

    expect(probe.available).toBe(false);
    expect(probe.reason).toBeTruthy();
  });

  it('parses result from the Cursor JSON envelope and uses ask mode by default', async () => {
    const envelope = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'pong',
      session_id: 'sess-1',
      request_id: 'req-1',
    });
    spawnMock.mockReturnValueOnce(createChild(envelope));

    const backend = new CursorCliReasoningBackend({
      bin: 'cursor-agent',
      model: 'auto',
      workspaceDir: '/tmp/ws',
    });
    const result = await backend.prompt('hello');

    expect(result).toBe('pong');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('-p');
    expect(args).toContain('--output-format');
    expect(args).toContain('json');
    expect(args).toContain('--model');
    expect(args).toContain('auto');
    expect(args).toContain('--mode');
    expect(args).toContain('ask');
    expect(args).toContain('--trust');
    expect(args).toContain('--workspace');
    expect(args).toContain('/tmp/ws');
    expect(withWallClockBudgetMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'cursor' }),
      expect.any(Function)
    );
  });

  it('parses structured JSON from the envelope result field', async () => {
    const envelope = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: JSON.stringify({ answer: 'structured-ok' }),
    });
    spawnMock.mockReturnValueOnce(createChild(envelope));

    const backend = new CursorCliReasoningBackend({ bin: 'cursor-agent', model: 'auto' });
    // Exercise complete() via delegateTask + manual schema path through prompt content.
    const text = await backend.delegateTask('return json', undefined, { profile: 'planner' });
    expect(JSON.parse(text)).toEqual({ answer: 'structured-ok' });

    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('--mode');
    expect(args).toContain('ask');
  });

  it('projects implementer permission args onto --force --sandbox enabled', async () => {
    const envelope = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
    });
    spawnMock.mockReturnValueOnce(createChild(envelope));

    const backend = new CursorCliReasoningBackend({ bin: 'cursor-agent', model: 'auto' });
    await withSandboxPolicy(
      resolveSandboxPolicy({ provider: 'cursor', mode: 'workspace-write', networkAccess: true }),
      async () => {
        await backend.delegateTask('edit something', undefined, { profile: 'implementer' });
      }
    );

    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('--force');
    expect(args).toContain('--sandbox');
    expect(args).toContain('enabled');
    expect(args).not.toContain('--mode');
  });

  it('rejects extra args that could override governed permission flags', () => {
    expect(() => new CursorCliReasoningBackend({ extraArgs: ['--force'] })).toThrow(
      /governed flag: --force/
    );
    expect(() => new CursorCliReasoningBackend({ extraArgs: ['--mode=ask'] })).toThrow(
      /governed flag: --mode/
    );
  });

  it('preserves non-governed extra args', async () => {
    const envelope = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'ok',
    });
    spawnMock.mockReturnValueOnce(createChild(envelope));

    const backend = new CursorCliReasoningBackend({ extraArgs: ['--verbose'] });
    await backend.prompt('hello');

    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('--verbose');
  });

  it('rejects error envelopes', async () => {
    const envelope = JSON.stringify({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: 'Named models unavailable',
    });
    spawnMock.mockReturnValueOnce(createChild(envelope));

    const backend = new CursorCliReasoningBackend({ bin: 'cursor-agent' });
    await expect(backend.prompt('hi')).rejects.toThrow(/Named models unavailable/);
  });

  it('builds a backend when the probe succeeds', () => {
    const backend = buildCursorCliBackendFromEnv(
      {
        KYBERION_CURSOR_CLI_BIN: 'cursor-agent',
        KYBERION_CURSOR_CLI_MODEL: 'composer-2.5',
      } as NodeJS.ProcessEnv,
      () => ({ available: true, authenticated: true })
    );
    expect(backend).toBeInstanceOf(CursorCliReasoningBackend);
    expect(backend?.name).toBe('cursor-cli');
  });

  it('fails closed and returns null when probe reports authenticated: false', () => {
    const backend = buildCursorCliBackendFromEnv(
      {
        KYBERION_CURSOR_CLI_BIN: 'cursor-agent',
      } as NodeJS.ProcessEnv,
      () => ({ available: true, authenticated: false, reason: 'login required' })
    );
    expect(backend).toBeNull();
  });

  it('resumes the CLI session on follow-up calls', async () => {
    const first = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'first',
      session_id: 'sess-follow-up',
    });
    const second = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'second',
      session_id: 'sess-follow-up',
    });
    spawnMock.mockReturnValueOnce(createChild(first)).mockReturnValueOnce(createChild(second));

    const backend = new CursorCliReasoningBackend({ bin: 'cursor-agent', model: 'auto' });
    await backend.prompt('first turn');
    await backend.prompt('second turn');

    expect(spawnMock).toHaveBeenCalledTimes(2);
    const [, secondArgs] = spawnMock.mock.calls[1];
    expect(secondArgs).toContain('--resume');
    expect(secondArgs).toContain('sess-follow-up');
  });

  it('clears the resumed session on resetSession', async () => {
    spawnMock.mockReturnValueOnce(
      createChild(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'ok',
          session_id: 'sess-reset',
        })
      )
    );

    const backend = new CursorCliReasoningBackend({ bin: 'cursor-agent', model: 'auto' });
    await backend.prompt('seed session');
    await backend.resetSession();

    spawnMock.mockReturnValueOnce(
      createChild(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          result: 'fresh',
        })
      )
    );
    await backend.prompt('fresh turn');

    const [, freshArgs] = spawnMock.mock.calls[1];
    expect(freshArgs).not.toContain('--resume');
  });

  it('retries once with auto when a named model is unavailable', async () => {
    const errorEnvelope = JSON.stringify({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: 'Named models unavailable Free plans can only use Auto.',
    });
    const okEnvelope = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'auto-ok',
    });
    spawnMock
      .mockReturnValueOnce(createChild(errorEnvelope))
      .mockReturnValueOnce(createChild(okEnvelope));

    const backend = new CursorCliReasoningBackend({ bin: 'cursor-agent', model: 'composer-2.5' });
    const result = await backend.prompt('hello');

    expect(result).toBe('auto-ok');
    expect(spawnMock).toHaveBeenCalledTimes(2);
    const [, retryArgs] = spawnMock.mock.calls[1];
    expect(retryArgs).toContain('--model');
    expect(retryArgs).toContain('auto');
  });

  it('maps model tiers to Cursor model ids', () => {
    expect(resolveCursorModelForTier('fast', 'auto')).toBe('auto');
    expect(resolveCursorModelForTier('deep', 'auto')).toBe('composer-2.5');
    expect(resolveCursorModelForTier('standard', 'composer-2.5')).toBe('composer-2.5');
  });

  it('keeps unused schema import path stable for future structured helpers', () => {
    // Guard against accidental removal of zod from the module surface used by tests.
    expect(z.object({ ok: z.boolean() }).parse({ ok: true })).toEqual({ ok: true });
  });

  describe('native subagent harness', () => {
    const previousFlag = process.env.KYBERION_CURSOR_NATIVE_SUBAGENT;

    afterEach(() => {
      if (previousFlag === undefined) delete process.env.KYBERION_CURSOR_NATIVE_SUBAGENT;
      else process.env.KYBERION_CURSOR_NATIVE_SUBAGENT = previousFlag;
    });

    it('exposes a valid native subagent adopter via the worktree harness', async () => {
      const askNativeSubagent = vi.fn(async (prompt: string, options: Record<string, unknown>) => ({
        text: `delegated: ${prompt}`,
        stopReason: 'completed',
        metadata: {
          nativeSubagent: {
            provider: 'cursor',
            mode: 'worktree-isolated-spawn',
            worktree: 'kyberion-implementer-1',
          },
        },
      }));
      const harnessSession = {
        boot: vi.fn(async () => undefined),
        ask: vi.fn(),
        askNativeSubagent,
        getRuntimeInfo: vi.fn(() => ({})),
      };
      const backend = new CursorCliReasoningBackend({ harnessSession });
      const adopter = backend.getNativeSubagentAdopter?.();

      await expect(
        adopter?.dispatch('investigate', 'ctx', { profile: 'explorer' })
      ).resolves.toContain('delegated:');

      expect(harnessSession.boot).toHaveBeenCalledOnce();
      expect(askNativeSubagent).toHaveBeenCalledWith(
        expect.stringContaining('Task: investigate'),
        expect.objectContaining({ profile: 'explorer', subagent: true, effort: 'medium' })
      );
      expect(backend.requiresNativeSubagent?.()).toBe(true);
      expect(adopter?.id).toBe('cursor-agent-cli');
      expect(adopter?.getInfo?.()).toMatchObject({
        provider: 'cursor',
        mode: 'worktree-isolated-spawn',
      });
    });

    it('turns off via KYBERION_CURSOR_NATIVE_SUBAGENT=0', () => {
      process.env.KYBERION_CURSOR_NATIVE_SUBAGENT = '0';
      const backend = new CursorCliReasoningBackend();
      expect(backend.getNativeSubagentAdopter()).toBeNull();
      expect(backend.requiresNativeSubagent()).toBe(false);
    });

    it('rejects a harness response that does not prove native delegation', async () => {
      const harnessSession = {
        boot: vi.fn(async () => undefined),
        ask: vi.fn(),
        askNativeSubagent: vi.fn(async () => ({ text: 'prompt-only', stopReason: 'completed' })),
      };
      const backend = new CursorCliReasoningBackend({ harnessSession });

      await expect(backend.getNativeSubagentAdopter()?.dispatch('task')).rejects.toThrow(
        '[SUBAGENT_UNAVAILABLE] Cursor CLI returned no native subagent metadata.'
      );
    });

    it('shuts down backend-owned harness sessions on resetSession', async () => {
      const shutdownMock = vi.fn(async () => {});
      const harnessSession = {
        boot: vi.fn(async () => undefined),
        ask: vi.fn(),
        askNativeSubagent: vi.fn(async () => ({
          text: 'ok',
          stopReason: 'completed',
          metadata: { nativeSubagent: { provider: 'cursor' } },
        })),
        shutdown: shutdownMock,
      };
      const backend = new CursorCliReasoningBackend({ harnessSession });
      await backend.resetSession();
      expect(shutdownMock).not.toHaveBeenCalled();

      const customBackend = new CursorCliReasoningBackend({ bin: 'cursor-agent' });
      (
        customBackend as unknown as { harnessSession: { shutdown: () => Promise<void> } }
      ).harnessSession = { shutdown: shutdownMock };
      await customBackend.resetSession();
      expect(shutdownMock).toHaveBeenCalledTimes(1);
    });
  });
});
