import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class FakeWallClockExceededError extends Error {}
  return {
    base: '',
    order: [] as string[],
    egressDenied: false,
    query: vi.fn(),
    spawn: vi.fn(),
    FakeWallClockExceededError,
  };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mocks.query }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: mocks.spawn };
});
vi.mock('../reasoning/reasoning-egress-scope.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../reasoning/reasoning-egress-scope.js')>()),
  assertReasoningEgressAllowed: () => {
    mocks.order.push('egress');
    if (mocks.egressDenied) throw new Error('[REASONING_EGRESS_DENIED] conformance denial');
  },
}));
vi.mock('../metrics.js', () => ({
  metrics: { record: vi.fn(), increment: vi.fn(), observe: vi.fn() },
}));
vi.mock('./codex-cli-query.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./codex-cli-query.js')>()),
  resolveCodexBinary: () => 'codex',
}));
// Hermetic: no active-child registry writes; keeps the seam's abort + budget contract.
vi.mock('../mission/delegation-concurrency.js', () => ({
  delegationChildHandleFromChildProcess: (child: { kill(signal: NodeJS.Signals): void }) => ({
    kill: (signal: NodeJS.Signals) => child.kill(signal),
  }),
  DelegationWallClockExceededError: mocks.FakeWallClockExceededError,
  withWallClockBudget: (
    opts: { budgetMs: number; signal?: AbortSignal; child?: { kill(signal: string): void } },
    fn: () => Promise<unknown>
  ) =>
    new Promise((resolve, reject) => {
      const stop = (error: Error) => {
        clearTimeout(timer);
        opts.child?.kill('SIGTERM');
        reject(error);
      };
      const timer = setTimeout(
        () => stop(new mocks.FakeWallClockExceededError('budget exceeded')),
        opts.budgetMs
      );
      const onAbort = () => stop(new Error('[DELEGATION_CANCELLED] provider operation aborted'));
      if (opts.signal?.aborted) return onAbort();
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      fn().then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    }),
}));
// Hermetic: route the governed scratch helper to a per-run ledger + root.
vi.mock('../workforce/workspace-ledger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workforce/workspace-ledger.js')>();
  const ledgerOptions = () => ({
    ledgerPath: path.join(mocks.base, 'workspaces', 'ledger.json'),
    allowedRoots: [path.join(mocks.base, 'workspaces')],
  });
  return {
    ...actual,
    createScratchWorkspace: (owner: Parameters<typeof actual.createScratchWorkspace>[0]) =>
      actual.createScratchWorkspace(owner, {
        ...ledgerOptions(),
        root: path.join(mocks.base, 'workspaces'),
      }),
    deleteRegisteredWorkspace: (id: string) =>
      actual.deleteRegisteredWorkspace(id, ledgerOptions()),
  };
});

import * as pathResolver from '../path-resolver.js';
import { safeExistsSync, safeMkdir, safeRmSync } from '../secure-io.js';
import { listReasoningProviderDescriptors } from '../reasoning/reasoning-provider-registry.js';
import {
  BUILTIN_ISOLATED_TEXT_GENERATOR_IDS,
  isIsolatedToolAttemptError,
  listIsolatedTextGenerators,
  registerIsolatedTextGenerator,
  resolveIsolatedTextGenerator,
  type IsolatedTextGenerator,
} from './isolated-text-generator.js';
import {
  describeIsolatedTextGeneratorConformance,
  type IsolatedGeneratorTransportCall,
} from './__tests__/isolated-text-generator-conformance.js';

mocks.base = pathResolver.sharedTmp(`vitest-isolated-text-generator/${randomUUID()}`);
const scratchRoot = path.join(mocks.base, 'workspaces') + path.sep;

beforeAll(() => safeMkdir(path.join(mocks.base, 'workspaces'), { recursive: true }));
afterAll(() => {
  vi.unstubAllEnvs();
  safeRmSync(mocks.base, { recursive: true, force: true });
});

function resetShared(calls: IsolatedGeneratorTransportCall[]): void {
  vi.clearAllMocks();
  calls.length = 0;
  mocks.order.length = 0;
  mocks.egressDenied = false;
}

// ---------------------------------------------------------------------------
// claude: fake Agent SDK query stream
// ---------------------------------------------------------------------------

const claudeCalls: IsolatedGeneratorTransportCall[] = [];
type ClaudeScript = { kind: 'success' | 'tool' | 'hang'; output?: unknown };

function scriptClaude(script: ClaudeScript): void {
  mocks.query.mockImplementation(
    ({
      options,
    }: {
      options: { cwd: string; env: Record<string, string>; abortController: AbortController };
    }) => {
      mocks.order.push('transport');
      const signal = options.abortController.signal;
      claudeCalls.push({
        cwd: options.cwd,
        cwdExistedDuringCall: safeExistsSync(options.cwd),
        env: options.env,
        stopped: () => signal.aborted,
      });
      const toolUse = (name: string) => ({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tu-1', name, input: {} }] },
      });
      const result = {
        type: 'result',
        subtype: 'success',
        structured_output: script.output,
        session_id: 's',
        total_cost_usd: 0,
        num_turns: 1,
      };
      return {
        async *[Symbol.asyncIterator]() {
          if (script.kind === 'hang') {
            await new Promise<void>((resolve) =>
              signal.aborted ? resolve() : signal.addEventListener('abort', () => resolve())
            );
            throw new Error('AbortError: query aborted');
          }
          yield toolUse(script.kind === 'tool' ? 'Bash' : 'StructuredOutput');
          yield result;
        },
      };
    }
  );
}

describeIsolatedTextGeneratorConformance({
  generatorId: 'claude',
  reset: () => resetShared(claudeCalls),
  order: () => mocks.order,
  denyEgress: () => {
    mocks.egressDenied = true;
  },
  scriptSuccess: (output) => scriptClaude({ kind: 'success', output }),
  scriptToolAttempt: (output) => scriptClaude({ kind: 'tool', output }),
  scriptHang: () => scriptClaude({ kind: 'hang' }),
  calls: () => claudeCalls,
  usesCwd: true,
  scratchRoot,
});

// ---------------------------------------------------------------------------
// codex: fake child process
// ---------------------------------------------------------------------------

const codexCalls: IsolatedGeneratorTransportCall[] = [];
interface ChildScript {
  stdout?: string;
  stderr?: string;
  hang?: boolean;
}

const codexVersion = (text = 'codex-cli 0.163.0\n'): ChildScript => ({ stdout: text });
const codexMessage = (output: unknown, stderr?: string): ChildScript => ({
  stdout:
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'i1', type: 'agent_message', text: JSON.stringify(output) },
    }) + '\n',
  ...(stderr ? { stderr } : {}),
});

function scriptCodex(...scripts: ChildScript[]): void {
  mocks.spawn.mockImplementation(
    (_bin: string, _args: string[], options: { cwd: string; env: Record<string, string> }) => {
      mocks.order.push('transport');
      const script = scripts.shift() ?? {};
      let killed = false;
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        kill: vi.fn(() => {
          killed = true;
          queueMicrotask(() => child.emit('close', null));
          return true;
        }),
      });
      codexCalls.push({
        cwd: options.cwd,
        cwdExistedDuringCall: safeExistsSync(options.cwd),
        env: options.env,
        stopped: () => killed,
      });
      if (!script.hang) {
        setImmediate(() => {
          if (script.stdout) child.stdout.write(script.stdout);
          if (script.stderr) child.stderr.write(script.stderr);
          child.stdout.end();
          child.stderr.end();
          setImmediate(() => child.emit('close', 0));
        });
      }
      return child;
    }
  );
}

describeIsolatedTextGeneratorConformance({
  generatorId: 'codex',
  reset: () => resetShared(codexCalls),
  order: () => mocks.order,
  denyEgress: () => {
    mocks.egressDenied = true;
  },
  scriptSuccess: (output) => scriptCodex(codexVersion(), codexMessage(output)),
  scriptToolAttempt: (output) =>
    scriptCodex(
      codexVersion(),
      codexMessage(output, 'ERROR codex_core::tools::router: error=exec_command disabled\n')
    ),
  scriptHang: () => scriptCodex(codexVersion(), { hang: true }),
  scriptUntestedVersion: () => scriptCodex(codexVersion('codex-cli 0.999.0\n')),
  calls: () => codexCalls,
  usesCwd: true,
  scratchRoot,
});

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

function fakeGenerator(overrides: Partial<IsolatedTextGenerator>): IsolatedTextGenerator {
  return {
    id: 'rogue',
    reasoningBackend: 'gemini-cli',
    isolation: 'structural',
    versionGated: false,
    describe: () => 'test generator',
    generate: async () => {
      throw new Error('must never run');
    },
    ...overrides,
  };
}

describe('isolated text generator registry', () => {
  it('lists exactly the built-ins, and they are exactly the descriptor-declared providers', () => {
    expect(listIsolatedTextGenerators().map((generator) => generator.id)).toEqual([
      ...BUILTIN_ISOLATED_TEXT_GENERATOR_IDS,
    ]);
    expect(BUILTIN_ISOLATED_TEXT_GENERATOR_IDS).toEqual(['claude', 'codex']);
    const declared = listReasoningProviderDescriptors()
      .filter((descriptor) => descriptor.isolated_text_generation)
      .map((descriptor) => [descriptor.mode, descriptor.isolated_text_generation?.isolation])
      .sort();
    const registered = listIsolatedTextGenerators()
      .map((generator) => [generator.reasoningBackend, generator.isolation])
      .sort();
    expect(registered).toEqual(declared);
    expect(declared).toEqual([
      ['claude-agent', 'structural'],
      ['codex-cli', 'fail_closed_detection'],
    ]);
  });

  it('fails closed for an unknown id and lists the registered ids', () => {
    expect(() => resolveIsolatedTextGenerator('gpt-with-tools')).toThrow(
      /\[ISOLATED_GENERATOR_UNKNOWN\].*registered: claude, codex/
    );
  });

  it('never resolves a generator its descriptor does not declare', () => {
    const unregisterRogue = registerIsolatedTextGenerator(fakeGenerator({}));
    const unregisterLiar = registerIsolatedTextGenerator(
      // Claims structural isolation on a provider declared fail_closed_detection.
      fakeGenerator({ id: 'liar', reasoningBackend: 'codex-cli', isolation: 'structural' })
    );
    const unregisterGhost = registerIsolatedTextGenerator(
      fakeGenerator({ id: 'ghost', reasoningBackend: 'no-such-provider' })
    );
    try {
      expect(() => resolveIsolatedTextGenerator('rogue')).toThrow(
        /\[ISOLATED_GENERATOR_UNDECLARED\] generator rogue .*declares none/
      );
      expect(() => resolveIsolatedTextGenerator('liar')).toThrow(
        /\[ISOLATED_GENERATOR_UNDECLARED\] generator liar .*declares fail_closed_detection/
      );
      expect(() => resolveIsolatedTextGenerator('ghost')).toThrow(/ISOLATED_GENERATOR_UNDECLARED/);
    } finally {
      unregisterRogue();
      unregisterLiar();
      unregisterGhost();
    }
    expect(listIsolatedTextGenerators().map((generator) => generator.id)).toEqual([
      'claude',
      'codex',
    ]);
  });

  it('rejects duplicate ids and malformed generators at registration', () => {
    expect(() => registerIsolatedTextGenerator(fakeGenerator({ id: 'claude' }))).toThrow(
      /ISOLATED_GENERATOR_DUPLICATE/
    );
    expect(() =>
      registerIsolatedTextGenerator(fakeGenerator({ id: 'odd', isolation: 'best_effort' as never }))
    ).toThrow(/ISOLATED_GENERATOR_INVALID/);
    expect(() => registerIsolatedTextGenerator(fakeGenerator({ id: 'Bad Id' }))).toThrow(
      /ISOLATED_GENERATOR_INVALID/
    );
  });

  it('classifies tool-attempt codes from any generator', () => {
    expect(isIsolatedToolAttemptError({ code: 'CODEX_TOOL_ATTEMPT' })).toBe(true);
    expect(isIsolatedToolAttemptError({ code: 'tool_attempt' })).toBe(true);
    expect(isIsolatedToolAttemptError({ code: 'CODEX_EXEC_FAILED' })).toBe(false);
    expect(isIsolatedToolAttemptError(new Error('x'))).toBe(false);
  });
});
