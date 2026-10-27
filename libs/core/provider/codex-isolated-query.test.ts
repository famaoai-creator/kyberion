import { withTaskCredentialBinding } from '../foundation/credential-binding.js';
import { withExecutionContext } from '../authority.js';
import { runInExecutionScope } from '../foundation/execution-scope.js';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const mocks = vi.hoisted(() => ({
  base: '',
  order: [] as string[],
  spawnMock: vi.fn(),
  assertEgress: vi.fn(),
  withWallClockBudgetMock: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: mocks.spawnMock };
});
vi.mock('../reasoning/reasoning-egress-scope.js', () => ({
  assertReasoningEgressAllowed: mocks.assertEgress,
}));
vi.mock('../metrics.js', () => ({
  metrics: { record: vi.fn(), increment: vi.fn(), observe: vi.fn() },
}));
// Hermetic: no real active-child registry write. The mock keeps the seam's
// abort contract (kill the child, reject) so abort wiring is still exercised.
vi.mock('../mission/delegation-concurrency.js', () => ({
  delegationChildHandleFromChildProcess: (child: {
    pid?: number;
    kill(signal: NodeJS.Signals): void;
  }) => ({
    pid: child.pid,
    kill: (signal: NodeJS.Signals) => child.kill(signal),
  }),
  withWallClockBudget: mocks.withWallClockBudgetMock,
  DelegationWallClockExceededError: class DelegationWallClockExceededError extends Error {},
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
    createScratchWorkspace: (owner: Parameters<typeof actual.createScratchWorkspace>[0]) => {
      mocks.order.push('workspace');
      return actual.createScratchWorkspace(owner, {
        ...ledgerOptions(),
        root: path.join(mocks.base, 'workspaces'),
      });
    },
    deleteRegisteredWorkspace: (id: string) =>
      actual.deleteRegisteredWorkspace(id, ledgerOptions()),
  };
});

import * as pathResolver from '../path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeRmSync } from '../secure-io.js';
import {
  CODEX_ISOLATED_EXEC_FLAGS,
  buildCodexIsolatedEnv,
  CodexIsolatedQueryError,
  detectCodexToolAttempt,
  parseCodexCliMajorMinor,
  runCodexIsolatedQuery,
} from './codex-isolated-query.js';

mocks.base = pathResolver.sharedTmp(`vitest-codex-isolated-query/${randomUUID()}`);

const schema = z.object({ reply: z.string() });
const BENIGN = {
  type: 'item.completed',
  item: {
    id: 'item_0',
    type: 'error',
    message: 'Code Mode is unavailable because code-mode host is disabled for this session.',
  },
};
const agentMessage = (text: string) => ({
  type: 'item.completed',
  item: { id: 'item_1', type: 'agent_message', text },
});

interface ChildScript {
  stdout?: string;
  stderr?: string;
  code?: number;
  hang?: boolean;
}

type FakeChild = EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};

interface SpawnCall {
  bin: string;
  args: string[];
  options: { cwd: string; env: Record<string, string> };
  stdin: string;
  cwdExisted: boolean;
  schemaText?: string;
  child: FakeChild;
}

const calls: SpawnCall[] = [];

function scriptChildren(...scripts: ChildScript[]) {
  mocks.spawnMock.mockImplementation(
    (bin: string, args: string[], options: SpawnCall['options']) => {
      mocks.order.push(args[0] === '--version' ? 'version' : 'exec');
      const script = scripts.shift() ?? {};
      const child: FakeChild = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        kill: vi.fn(() => {
          queueMicrotask(() => child.emit('close', null));
          return true;
        }),
      });
      const call: SpawnCall = {
        bin,
        args,
        options,
        stdin: '',
        cwdExisted: safeExistsSync(options.cwd),
        child,
      };
      const schemaIndex = args.indexOf('--output-schema');
      if (schemaIndex >= 0) {
        call.schemaText = String(safeReadFile(args[schemaIndex + 1], { encoding: 'utf8' }));
      }
      child.stdin.on('data', (chunk: Buffer) => {
        call.stdin += chunk.toString();
      });
      calls.push(call);
      if (!script.hang) {
        setImmediate(() => {
          if (script.stdout) child.stdout.write(script.stdout);
          if (script.stderr) child.stderr.write(script.stderr);
          child.stdout.end();
          child.stderr.end();
          setImmediate(() => child.emit('close', script.code ?? 0));
        });
      }
      return child;
    }
  );
}

const version = (text = 'codex-cli 0.163.0\n'): ChildScript => ({ stdout: text });
const events = (...lines: unknown[]): ChildScript => ({
  stdout: lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
});

function run(overrides: Partial<Parameters<typeof runCodexIsolatedQuery>[0]> = {}) {
  return runCodexIsolatedQuery({
    systemPrompt: 'SYSTEM-RULES',
    userPrompt: '<untrusted>peer text</untrusted>',
    schema,
    bin: 'codex',
    timeoutMs: 5_000,
    ...overrides,
  });
}

function scratchDirs(): string[] {
  const root = path.join(mocks.base, 'workspaces');
  return calls.map((call) => call.options.cwd).filter((dir) => dir.startsWith(root));
}

describe('isolated Codex credential environment', () => {
  it('rejects an unbound tenant before version or request spawn', async () => {
    mocks.spawnMock.mockClear();
    await runInExecutionScope({ tenantBound: true, tenantSlug: 'isolated-fixture' }, async () => {
      expect(() =>
        buildCodexIsolatedEnv({ HOME: '/operator', CODEX_HOME: '/operator/.codex' })
      ).toThrow('CREDENTIAL_BINDING_REQUIRED');
      await expect(
        runCodexIsolatedQuery({ systemPrompt: 'system', userPrompt: 'must not send', schema })
      ).rejects.toThrow('CREDENTIAL_BINDING_REQUIRED');
    });
    expect(mocks.spawnMock).not.toHaveBeenCalled();
  });
  it('uses only the validated tenant HOME even when a caller passes an operator profile', () => {
    const tenant = 'isolated-fixture';
    const home = pathResolver.rootResolve(
      `active/shared/tmp/confidential/${tenant}/provider-auth/vitest-isolated-env`
    );
    withExecutionContext(
      'sovereign_concierge',
      () => {
        safeMkdir(home, { recursive: true });
        try {
          withTaskCredentialBinding(
            {
              tenantSlug: tenant,
              secrets: {},
              providerEnvironments: {
                codex: { HOME: home, CODEX_HOME: path.join(home, '.codex'), PATH: '/fixture/bin' },
              },
            },
            () => {
              expect(
                buildCodexIsolatedEnv({
                  HOME: '/operator',
                  CODEX_HOME: '/operator/.codex',
                  PATH: '/operator/bin',
                })
              ).toEqual({
                PATH: '/fixture/bin',
                HOME: home,
                CODEX_HOME: path.join(home, '.codex'),
              });
            }
          );
        } finally {
          safeRmSync(home, { recursive: true, force: true });
        }
      },
      'sovereign',
      tenant
    );
  });
});

describe('parseCodexCliMajorMinor', () => {
  it('reads major.minor from codex --version output', () => {
    expect(parseCodexCliMajorMinor('codex-cli 0.163.0\n')).toBe('0.163');
    expect(parseCodexCliMajorMinor('codex-cli v1.2')).toBe('1.2');
    expect(parseCodexCliMajorMinor('codex-cli nightly')).toBeUndefined();
  });

  it('stays linear on long digit runs (no regex backtracking)', () => {
    const hostile = `codex-cli ${'0'.repeat(100_000)}x`;
    const started = Date.now();
    expect(parseCodexCliMajorMinor(hostile)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(200);
  });
});

describe('runCodexIsolatedQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    calls.length = 0;
    mocks.order.length = 0;
    mocks.assertEgress.mockImplementation(() => mocks.order.push('egress'));
    mocks.withWallClockBudgetMock.mockImplementation(
      (
        opts: { signal?: AbortSignal; child?: { kill(signal: string): void } },
        fn: () => Promise<unknown>
      ) =>
        new Promise((resolve, reject) => {
          const onAbort = () => {
            opts.child?.kill('SIGTERM');
            reject(new Error('[DELEGATION_CANCELLED] provider operation aborted'));
          };
          if (opts.signal?.aborted) return onAbort();
          opts.signal?.addEventListener('abort', onAbort, { once: true });
          fn().then(resolve, reject);
        })
    );
    safeMkdir(path.join(mocks.base, 'workspaces'), { recursive: true });
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    safeRmSync(mocks.base, { recursive: true, force: true });
  });

  it('spawns every isolation flag in an empty scratch cwd with a minimal env, then removes it', async () => {
    vi.stubEnv('KYBERION_PEER_SHARED_SECRET', 'secret-value');
    vi.stubEnv('MISSION_ROLE', 'peer_responder_reader');
    vi.stubEnv('OPENAI_API_KEY', 'sk-should-not-leak');
    vi.stubEnv('HOME', '/home/tester');
    vi.stubEnv('PATH', '/usr/bin');
    scriptChildren(version(), events(BENIGN, agentMessage('{"reply":"hello"}')));

    const result = await run();

    expect(result.parsed).toEqual({ reply: 'hello' });
    expect(calls).toHaveLength(2);
    expect(calls[0].args).toEqual(['--version']);
    const exec = calls[1];
    expect(exec.args[0]).toBe('exec');
    // The flag block is passed verbatim and in order.
    expect(exec.args.slice(1, 1 + CODEX_ISOLATED_EXEC_FLAGS.length)).toEqual([
      ...CODEX_ISOLATED_EXEC_FLAGS,
    ]);
    for (const flag of [
      '--ignore-user-config',
      '--ignore-rules',
      '--ephemeral',
      '--skip-git-repo-check',
      'approval_policy=never',
      'web_search=disabled',
      'mcp_servers={}',
      'shell_tool',
      'unified_exec',
      'code_mode_host',
      'multi_agent',
      'collaboration_modes',
      '--json',
    ]) {
      expect(exec.args).toContain(flag);
    }
    expect(exec.args.join(' ')).toContain('-s read-only');
    expect(exec.args).not.toContain('include_apply_patch_tool');
    const schemaPath = exec.args[exec.args.indexOf('--output-schema') + 1];
    expect(path.dirname(schemaPath)).toBe(exec.options.cwd);
    expect(exec.args.at(-1)).toBe('-');
    // The prompt goes through stdin: system prompt first, caller framing intact.
    expect(exec.stdin.indexOf('SYSTEM-RULES')).toBeLessThan(exec.stdin.indexOf('<untrusted>'));
    expect(exec.stdin).toContain('<untrusted>peer text</untrusted>');

    expect(exec.cwdExisted).toBe(true);
    expect(scratchDirs()).toHaveLength(2);
    expect(safeExistsSync(exec.options.cwd)).toBe(false);
    for (const call of calls) {
      expect(Object.keys(call.options.env).sort()).toEqual(
        Object.keys(call.options.env)
          .filter((key) => ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'CODEX_HOME'].includes(key))
          .sort()
      );
      expect(call.options.env.HOME).toBe('/home/tester');
      expect(call.options.env.PATH).toBe('/usr/bin');
      expect(Object.keys(call.options.env).some((key) => /^(KYBERION_|MISSION_)/.test(key))).toBe(
        false
      );
      expect(call.options.env.OPENAI_API_KEY).toBeUndefined();
    }
  });

  it('writes the zod schema as the codex output schema', async () => {
    scriptChildren(version(), events(agentMessage('{"reply":"ok"}')));
    await run();
    expect(JSON.parse(calls[1].schemaText ?? '')).toMatchObject({
      type: 'object',
      properties: { reply: { type: 'string' } },
      required: ['reply'],
    });
  });

  it('asserts egress first and a denial never spawns or creates a workspace', async () => {
    scriptChildren(version(), events(agentMessage('{"reply":"ok"}')));
    await run();
    expect(mocks.order).toEqual(['egress', 'workspace', 'version', 'exec']);

    vi.clearAllMocks();
    mocks.order.length = 0;
    mocks.assertEgress.mockImplementation(() => {
      throw new Error('[REASONING_EGRESS_DENIED] codex not attested');
    });
    await expect(run()).rejects.toThrow('REASONING_EGRESS_DENIED');
    expect(mocks.spawnMock).not.toHaveBeenCalled();
    expect(mocks.order).toEqual([]);
  });

  it('refuses an untested codex-cli version unless allowUntestedVersion', async () => {
    scriptChildren(version('codex-cli 0.170.1\n'));
    const error = await run().catch((caught) => caught);
    expect(error).toBeInstanceOf(CodexIsolatedQueryError);
    expect(error.code).toBe('CODEX_ISOLATION_UNTESTED');
    expect(error.message).toContain('[CODEX_ISOLATION_UNTESTED]');
    expect(error.message).toContain('version=0.170');
    expect(calls).toHaveLength(1);
    expect(safeExistsSync(calls[0].options.cwd)).toBe(false);

    calls.length = 0;
    scriptChildren(version('codex-cli 0.170.1\n'), events(agentMessage('{"reply":"ok"}')));
    await expect(run({ allowUntestedVersion: true })).resolves.toMatchObject({
      parsed: { reply: 'ok' },
    });
  });

  it('fails closed on a tool-router stderr line and removes the scratch dir', async () => {
    scriptChildren(version(), {
      ...events(BENIGN, agentMessage('{"reply":"looks fine"}')),
      stderr:
        '2026-10-18T00:00:00Z ERROR codex_core::tools::router: error=code-mode host is disabled\n',
    });
    const error = await run().catch((caught) => caught);
    expect(error.code).toBe('CODEX_TOOL_ATTEMPT');
    expect(error.message).toContain('[CODEX_TOOL_ATTEMPT]');
    expect(safeExistsSync(calls[1].options.cwd)).toBe(false);
  });

  it('fails closed on a disallowed --json item type', async () => {
    for (const itemType of [
      'command_execution',
      'file_change',
      'mcp_tool_call',
      'web_search',
      'collab_tool_call',
      'todo_list',
    ]) {
      calls.length = 0;
      scriptChildren(
        version(),
        events(
          { type: 'item.started', item: { id: 'x', type: itemType } },
          agentMessage('{"reply":"ok"}')
        )
      );
      await expect(run()).rejects.toMatchObject({ code: 'CODEX_TOOL_ATTEMPT' });
    }
  });

  it('accepts lifecycle events, reasoning and the benign code-mode error item', async () => {
    scriptChildren(
      version(),
      events(
        { type: 'thread.started', thread_id: 't' },
        { type: 'turn.started' },
        BENIGN,
        { type: 'item.completed', item: { id: 'r', type: 'reasoning', text: 'thinking' } },
        agentMessage('{"reply":"first"}'),
        agentMessage('{"reply":"final"}'),
        { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 3 } }
      )
    );
    const result = await run();
    expect(result.parsed).toEqual({ reply: 'final' });
    expect(result.rawEvents).toHaveLength(7);
  });

  it('treats an unknown error item as a tool attempt', () => {
    expect(
      detectCodexToolAttempt({
        stderr: '',
        events: [{ type: 'item.completed', item: { type: 'error', message: 'other failure' } }],
      })
    ).toContain('item type error');
    expect(
      detectCodexToolAttempt({ stderr: 'Reading prompt from stdin...\n', events: [BENIGN] })
    ).toBeUndefined();
    expect(detectCodexToolAttempt({ stderr: '', events: [{ type: 'session.mystery' }] })).toContain(
      'event type session.mystery'
    );
  });

  it('rejects invalid JSON and schema mismatches', async () => {
    scriptChildren(version(), events(agentMessage('not json at all')));
    await expect(run()).rejects.toMatchObject({ code: 'CODEX_PARSE_FAILED' });
    calls.length = 0;
    scriptChildren(version(), events(agentMessage('{"answer":"wrong field"}')));
    await expect(run()).rejects.toMatchObject({ code: 'CODEX_PARSE_FAILED' });
    calls.length = 0;
    scriptChildren(version(), events(BENIGN));
    await expect(run()).rejects.toMatchObject({ code: 'CODEX_NO_RESULT' });
  });

  it('reports a non-zero exit as CODEX_EXEC_FAILED', async () => {
    scriptChildren(version(), { stderr: 'not logged in\n', code: 1 });
    await expect(run()).rejects.toMatchObject({ code: 'CODEX_EXEC_FAILED' });
  });

  it('abort kills the child and removes the scratch dir', async () => {
    scriptChildren(version(), { hang: true });
    const abortController = new AbortController();
    const pending = run({ abortController });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    abortController.abort();
    await expect(pending).rejects.toThrow('DELEGATION_CANCELLED');
    expect(calls[1].child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(safeExistsSync(calls[1].options.cwd)).toBe(false);
    const budget = mocks.withWallClockBudgetMock.mock.calls[1][0];
    expect(budget).toMatchObject({ provider: 'codex', budgetMs: 5_000 });
    expect(budget.signal).toBe(abortController.signal);
  });
});
