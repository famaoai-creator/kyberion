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
      () => ({ available: true })
    );
    expect(backend).toBeInstanceOf(CursorCliReasoningBackend);
    expect(backend?.name).toBe('cursor-cli');
  });

  it('keeps unused schema import path stable for future structured helpers', () => {
    // Guard against accidental removal of zod from the module surface used by tests.
    expect(z.object({ ok: z.boolean() }).parse({ ok: true })).toEqual({ ok: true });
  });
});
