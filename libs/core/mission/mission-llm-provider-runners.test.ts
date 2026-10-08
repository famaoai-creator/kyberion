import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { z } from 'zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as pathResolver from '../path-resolver.js';
import { safeWriteFile } from '../secure-io.js';

// Runbook §7: the dedicated codex / gemini structured runners used by mission
// distillation must run without write access, from the scratch cwd, with the
// prompt off argv where the CLI reads stdin. The real runners execute here
// against a fake `spawn`, so the assertions cover the argv/cwd/stdin the CLI
// would actually receive.

const mocks = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: mocks.spawnMock };
});
// Denials raise ops alerts; keep the shared sink untouched.
vi.mock('../ops-alert.js', () => ({ sendOpsAlert: vi.fn() }));
// Usage metering and the wall-clock child registry persist runtime records;
// this suite must not write them.
vi.mock('../cli-usage-metering.js', () => ({ recordEstimatedCliUsage: vi.fn() }));
vi.mock('./delegation-concurrency.js', () => ({
  delegationChildHandleFromChildProcess: (child: FakeChild) => ({
    pid: child.pid,
    kill: (signal: NodeJS.Signals) => child.kill(signal),
  }),
  withWallClockBudget: (_opts: unknown, fn: () => Promise<unknown>) => fn(),
  DelegationWallClockExceededError: class DelegationWallClockExceededError extends Error {},
}));

import { llmShellScratchCwd, type LlmProfile, runStructuredLlmProfile } from './mission-llm.js';

type FakeChild = EventEmitter & {
  pid?: number;
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

/** The runners forward the profile as CLI options, so `bin` pins a fake binary. */
type RunnerProfile = LlmProfile & { bin: string; extraArgs?: string[]; cwd?: string };

// A profile override must not re-widen the runner's projection or move its cwd.
const WIDENING_FIELDS = { cwd: '/elsewhere/repo-root', timeout_ms: 45_000 };

interface SpawnCall {
  bin: string;
  args: string[];
  cwd: string | undefined;
  stdin: string;
}

const PROMPT_MARKER = 'mission prompt 7f3a';
const schema = z.object({ answer: z.number() });

function fakeChild(onStdinEnd: (stdin: string) => string): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = vi.fn();
  let stdin = '';
  child.stdin.on('data', (chunk: Buffer) => (stdin += chunk.toString()));
  child.stdin.on('finish', () => {
    const out = onStdinEnd(stdin);
    child.stdout.end(out);
    child.stderr.end();
    queueMicrotask(() => child.emit('close', 0));
  });
  return child;
}

function captureSpawn(respond: (call: SpawnCall) => string): SpawnCall[] {
  const calls: SpawnCall[] = [];
  mocks.spawnMock.mockImplementation((bin: string, args: string[], options?: { cwd?: string }) => {
    const call: SpawnCall = { bin, args, cwd: options?.cwd, stdin: '' };
    calls.push(call);
    return fakeChild((stdin) => {
      call.stdin = stdin;
      return respond(call);
    });
  });
  return calls;
}

afterEach(() => {
  mocks.spawnMock.mockReset();
});

describe('mission-llm codex-cli runner (runbook §7)', () => {
  it('runs codex read-only from the scratch cwd with the prompt on stdin', async () => {
    const calls = captureSpawn((call) => {
      // codex writes its last message to --output-last-message.
      const outputPath = call.args[call.args.indexOf('--output-last-message') + 1]!;
      safeWriteFile(outputPath, JSON.stringify({ answer: 1 }));
      return '';
    });

    const result = await runStructuredLlmProfile(
      {
        command: 'codex',
        args: [],
        adapter: 'codex-cli',
        bin: 'fake-codex',
      } satisfies RunnerProfile,
      PROMPT_MARKER,
      schema,
      { systemPrompt: 'SYSTEM: return JSON', egress: { dataTier: 'public' } }
    );

    expect(result).toEqual({ answer: 1 });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.bin).toBe('fake-codex');
    const sandbox = call!.args.indexOf('--sandbox');
    expect(call!.args.slice(sandbox, sandbox + 2)).toEqual(['--sandbox', 'read-only']);
    expect(call!.args).not.toContain('workspace-write');
    expect(call!.args.join(' ')).not.toContain('7f3a');
    expect(call!.args.at(-1)).toBe('-');
    expect(call!.stdin).toContain(PROMPT_MARKER);
    const scratch = llmShellScratchCwd();
    expect(call!.cwd).toBe(scratch);
    expect(call!.cwd).not.toBe(pathResolver.rootDir());
    expect(call!.args.slice(call!.args.indexOf('-C'), call!.args.indexOf('-C') + 2)).toEqual([
      '-C',
      scratch,
    ]);
  });
});

describe('mission-llm gemini-cli runner (runbook §7)', () => {
  it('runs gemini in the no-write plan mode from the scratch cwd with the prompt on stdin', async () => {
    const calls = captureSpawn(() => JSON.stringify({ response: JSON.stringify({ answer: 2 }) }));

    const result = await runStructuredLlmProfile(
      {
        command: 'gemini',
        args: [],
        adapter: 'gemini-cli',
        bin: 'fake-gemini',
      } satisfies RunnerProfile,
      PROMPT_MARKER,
      schema,
      { systemPrompt: 'SYSTEM: return JSON', egress: { dataTier: 'public' } }
    );

    expect(result).toEqual({ answer: 2 });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.bin).toBe('fake-gemini');
    // gemini-cli descriptor `permission_profiles.explorer`.
    const mode = call!.args.indexOf('--approval-mode');
    expect(call!.args.slice(mode, mode + 2)).toEqual(['--approval-mode', 'plan']);
    expect(call!.args).toContain('--sandbox');
    expect(call!.args).not.toContain('-y');
    expect(call!.args).not.toContain('--yolo');
    expect(call!.args).not.toContain('yolo');
    expect(call!.args.join(' ')).not.toContain('7f3a');
    expect(call!.stdin).toBe(`SYSTEM: return JSON\n\n${PROMPT_MARKER}`);
    expect(call!.cwd).toBe(llmShellScratchCwd());
    expect(call!.cwd).not.toBe(pathResolver.rootDir());
  });
});

describe('mission-llm structured runners ignore widening profile fields', () => {
  it('keeps codex read-only and in the scratch cwd despite profile extraArgs and cwd', async () => {
    const calls = captureSpawn((call) => {
      const outputPath = call.args[call.args.indexOf('--output-last-message') + 1]!;
      safeWriteFile(outputPath, JSON.stringify({ answer: 3 }));
      return '';
    });

    await runStructuredLlmProfile(
      {
        command: 'codex',
        args: [],
        adapter: 'codex-cli',
        bin: 'fake-codex',
        extraArgs: ['--sandbox', 'workspace-write', '--dangerously-bypass-approvals-and-sandbox'],
        ...WIDENING_FIELDS,
      } satisfies RunnerProfile,
      PROMPT_MARKER,
      schema,
      { egress: { dataTier: 'public' } }
    );

    const [call] = calls;
    expect(call!.args.filter((arg) => arg === '--sandbox')).toHaveLength(1);
    expect(call!.args).toContain('read-only');
    expect(call!.args).not.toContain('workspace-write');
    expect(call!.args.some((arg) => arg.startsWith('--dangerously-'))).toBe(false);
    expect(call!.cwd).toBe(llmShellScratchCwd());
  });

  it('keeps gemini in plan mode and in the scratch cwd despite profile extraArgs and cwd', async () => {
    const calls = captureSpawn(() => JSON.stringify({ response: JSON.stringify({ answer: 4 }) }));

    await runStructuredLlmProfile(
      {
        command: 'gemini',
        args: [],
        adapter: 'gemini-cli',
        bin: 'fake-gemini',
        extraArgs: ['--approval-mode', 'yolo', '-y'],
        ...WIDENING_FIELDS,
      } satisfies RunnerProfile,
      PROMPT_MARKER,
      schema,
      { egress: { dataTier: 'public' } }
    );

    const [call] = calls;
    expect(call!.args.filter((arg) => arg === '--approval-mode')).toHaveLength(1);
    expect(call!.args).toContain('plan');
    expect(call!.args).not.toContain('yolo');
    expect(call!.args).not.toContain('-y');
    expect(call!.cwd).toBe(llmShellScratchCwd());
  });
});
