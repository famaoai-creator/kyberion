import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CursorCliSessionAdapter } from './cursor-cli-session-adapter.js';

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
  child.pid = 5151;

  setImmediate(() => {
    child.stdout.write(stdoutText);
    child.stdout.end();
    child.stderr.end();
    child.emit('close', exitCode);
  });

  return child;
}

describe('cursor-cli-session-adapter', () => {
  afterEach(() => {
    spawnMock.mockClear();
    withWallClockBudgetMock.mockClear();
  });

  it('runs native subagent dispatch in an isolated worktree with permission args', async () => {
    const envelope = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'subagent done',
      session_id: 'cursor-sub-1',
    });
    spawnMock.mockReturnValueOnce(createChild(envelope));

    const adapter = new CursorCliSessionAdapter({
      bin: 'cursor-agent',
      model: 'auto',
      workspaceDir: '/tmp/ws',
      spawnProcess: spawnMock,
    });
    await adapter.boot();
    const response = await adapter.askNativeSubagent('complete the bounded task', {
      profile: 'implementer',
      subagent: true,
      effort: 'medium',
    });

    expect(response.text).toBe('subagent done');
    expect(response.metadata?.nativeSubagent).toMatchObject({
      provider: 'cursor',
      mode: 'worktree-isolated-spawn',
      worktree: expect.stringMatching(/^kyberion-implementer-[a-f0-9]+-1$/),
      profile: 'implementer',
      proof: 'kyberion_owned_worktree_spawn',
      sessionId: 'cursor-sub-1',
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('--worktree');
    expect(args.some((a) => /^kyberion-implementer-[a-f0-9]+-1$/.test(a))).toBe(true);
    expect(args).toContain('--force');
    expect(args).toContain('--sandbox');
    expect(args).toContain('enabled');
    expect(args).toContain('--workspace');
    expect(args).toContain('/tmp/ws');
  });

  it('increments worktree names across successive native dispatches', async () => {
    const envelope = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'ok',
    });
    spawnMock.mockReturnValueOnce(createChild(envelope)).mockReturnValueOnce(createChild(envelope));

    const adapter = new CursorCliSessionAdapter({
      bin: 'cursor-agent',
      spawnProcess: spawnMock,
    });
    await adapter.askNativeSubagent('first', { profile: 'explorer' });
    await adapter.askNativeSubagent('second', { profile: 'explorer' });

    const [, firstArgs] = spawnMock.mock.calls[0];
    const [, secondArgs] = spawnMock.mock.calls[1];
    expect(firstArgs.some((a) => /^kyberion-explorer-[a-f0-9]+-1$/.test(a))).toBe(true);
    expect(secondArgs.some((a) => /^kyberion-explorer-[a-f0-9]+-2$/.test(a))).toBe(true);
  });
  it('routes fast and deep tiers to corresponding models', async () => {
    const envelope = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'ok',
    });
    spawnMock.mockReturnValue(createChild(envelope));

    const adapter = new CursorCliSessionAdapter({
      bin: 'cursor-agent',
      model: 'auto',
      spawnProcess: spawnMock,
    });
    await adapter.askNativeSubagent('run task', { profile: 'implementer', tier: 'deep' });
    const [, args] = spawnMock.mock.calls[0];
    const modelIdx = args.indexOf('--model');
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(args[modelIdx + 1]).toBe('composer-2.5');
  });
});
