import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import {
  buildOpencodeCliBackendFromEnv,
  OpencodeCliReasoningBackend,
  parseOpencodeRunJson,
  probeOpencodeCliAvailability,
} from './opencode-cli-reasoning-backend.js';
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

function ndjson(...events: unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join('\n');
}

function textEvent(text: string): unknown {
  return {
    type: 'text',
    timestamp: 1,
    sessionID: 'ses-1',
    part: { id: 'prt-1', messageID: 'msg-1', sessionID: 'ses-1', type: 'text', text },
  };
}

describe('opencode-cli-reasoning-backend', () => {
  it('routes OpenCode CLI environment reads through the governed accessor', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('libs/core/opencode-cli-reasoning-backend.ts'), {
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
    const backend = buildOpencodeCliBackendFromEnv(
      { KYBERION_OPENCODE_CLI_BIN: 'opencode' } as NodeJS.ProcessEnv,
      () => ({ available: false, reason: 'crash on launch' })
    );

    expect(backend).toBeNull();
  });

  it('can report a missing binary as unavailable', () => {
    const probe = probeOpencodeCliAvailability(
      { KYBERION_OPENCODE_CLI_BIN: '__definitely_missing_binary__' } as NodeJS.ProcessEnv,
      { bin: '__definitely_missing_binary__', timeoutMs: 250 }
    );

    expect(probe.available).toBe(false);
    expect(probe.reason).toBeTruthy();
  });

  it('collects answer text from NDJSON events and uses the plan agent by default', async () => {
    spawnMock.mockReturnValueOnce(
      createChild(
        ndjson({ type: 'step_start' }, textEvent('po'), textEvent('ng'), { type: 'step_finish' })
      )
    );

    const backend = new OpencodeCliReasoningBackend({
      bin: 'opencode',
      model: 'opencode/muse-spark-1.3-contributor-free',
      workspaceDir: '/tmp/ws',
    });
    const result = await backend.prompt('hello');

    expect(result).toBe('pong');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [bin, args] = spawnMock.mock.calls[0];
    expect(bin).toBe('opencode');
    expect(args).toContain('run');
    expect(args).toContain('--format');
    expect(args).toContain('json');
    expect(args).toContain('--model');
    expect(args).toContain('opencode/muse-spark-1.3-contributor-free');
    expect(args).toContain('--agent');
    expect(args).toContain('plan');
    expect(args).toContain('--dir');
    expect(args).toContain('/tmp/ws');
    expect(args).not.toContain('--auto');
    expect(withWallClockBudgetMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'opencode' }),
      expect.any(Function)
    );
  });

  it('parses structured JSON from concatenated text parts', async () => {
    spawnMock.mockReturnValueOnce(
      createChild(ndjson(textEvent(JSON.stringify({ answer: 'structured-ok' }))))
    );

    const backend = new OpencodeCliReasoningBackend({ bin: 'opencode' });
    const text = await backend.delegateTask('return json', undefined, { profile: 'planner' });
    expect(JSON.parse(text)).toEqual({ answer: 'structured-ok' });

    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('--agent');
    expect(args).toContain('plan');
  });

  it('projects the implementer profile onto the build agent', async () => {
    spawnMock.mockReturnValueOnce(createChild(ndjson(textEvent('done'))));

    const backend = new OpencodeCliReasoningBackend({ bin: 'opencode' });
    await withSandboxPolicy(
      resolveSandboxPolicy({ provider: 'opencode', mode: 'workspace-write', networkAccess: true }),
      async () => {
        await backend.delegateTask('edit something', undefined, { profile: 'implementer' });
      }
    );

    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('--agent');
    expect(args).toContain('build');
  });

  it('rejects extra args that could override governed flags', () => {
    expect(() => new OpencodeCliReasoningBackend({ extraArgs: ['--auto'] })).toThrow(
      /governed flag: --auto/
    );
    expect(() => new OpencodeCliReasoningBackend({ extraArgs: ['--model=x'] })).toThrow(
      /governed flag: --model/
    );
  });

  it('preserves non-governed extra args', async () => {
    spawnMock.mockReturnValueOnce(createChild(ndjson(textEvent('ok'))));

    const backend = new OpencodeCliReasoningBackend({ extraArgs: ['--log-level', 'ERROR'] });
    await backend.prompt('hello');

    const [, args] = spawnMock.mock.calls[0];
    expect(args).toContain('--log-level');
  });

  it('rejects error events', async () => {
    spawnMock.mockReturnValueOnce(
      createChild(ndjson({ type: 'error', message: 'provider exploded' }))
    );

    const backend = new OpencodeCliReasoningBackend({ bin: 'opencode' });
    await expect(backend.prompt('hi')).rejects.toThrow(/provider exploded/);
  });

  it('rejects output without text parts', async () => {
    spawnMock.mockReturnValueOnce(createChild(ndjson({ type: 'step_start' })));

    const backend = new OpencodeCliReasoningBackend({ bin: 'opencode' });
    await expect(backend.prompt('hi')).rejects.toThrow(/did not emit text/);
  });

  it('appends a JSON shape hint to structured prompts', async () => {
    spawnMock.mockReturnValueOnce(createChild(ndjson(textEvent('{"hypotheses": []}'))));

    const backend = new OpencodeCliReasoningBackend({ bin: 'opencode' });
    await backend.divergePersonas({ topic: 't', personas: ['skeptic'] });

    const [, args] = spawnMock.mock.calls[0];
    const prompt = args[args.length - 1] as string;
    expect(prompt).toContain('hypotheses');
    expect(prompt).toContain('proposed_by');
  });

  it('parseOpencodeRunJson joins split text parts', () => {
    expect(parseOpencodeRunJson(ndjson(textEvent('a'), textEvent('b')))).toBe('ab');
  });

  it('builds a backend when the probe succeeds', () => {
    const backend = buildOpencodeCliBackendFromEnv(
      {
        KYBERION_OPENCODE_CLI_BIN: 'opencode',
        KYBERION_OPENCODE_CLI_MODEL: 'opencode/muse-spark-1.3-contributor-free',
      } as NodeJS.ProcessEnv,
      () => ({ available: true })
    );
    expect(backend).toBeInstanceOf(OpencodeCliReasoningBackend);
    expect(backend?.name).toBe('opencode-cli');
  });
});
