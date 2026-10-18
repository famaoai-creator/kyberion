import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  base: '',
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mocks.query }));
vi.mock('../reasoning/reasoning-egress-scope.js', () => ({
  assertReasoningEgressAllowed: vi.fn(),
}));
vi.mock('../metrics.js', () => ({
  metrics: { record: vi.fn(), increment: vi.fn(), observe: vi.fn() },
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
import { runClaudeAgentQuery } from './claude-agent-query.js';

mocks.base = pathResolver.sharedTmp(`vitest-claude-agent-isolation/${randomUUID()}`);

const SUCCESS = {
  type: 'result',
  subtype: 'success',
  structured_output: { answer: 'ok' },
  session_id: 'sess-1',
  total_cost_usd: 0,
  num_turns: 1,
};

function stream(messages: Record<string, unknown>[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const message of messages) yield message;
    },
  };
}

const schema = z.object({ answer: z.string() });

function capturedOptions(): Record<string, unknown> {
  return mocks.query.mock.calls[0][0].options as Record<string, unknown>;
}

describe('runClaudeAgentQuery isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    safeMkdir(path.join(mocks.base, 'workspaces'), { recursive: true });
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    safeRmSync(mocks.base, { recursive: true, force: true });
  });

  it('strict isolation disables settings/MCP and uses a scratch cwd + minimal env', async () => {
    vi.stubEnv('KYBERION_PEER_SHARED_SECRET', 'secret-value');
    vi.stubEnv('KYBERION_PEER_SHARED_SECRET_NEXT', 'secret-value-2');
    vi.stubEnv('KYBERION_PROVIDER_ENV_ALLOWLIST', '0');
    vi.stubEnv('MISSION_ID', 'MSN-1');
    vi.stubEnv('OPENAI_API_KEY', 'sk-other');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant');
    let cwdDuringQuery = '';
    mocks.query.mockImplementation(({ options }: { options: { cwd: string } }) => {
      cwdDuringQuery = options.cwd;
      expect(safeExistsSync(options.cwd)).toBe(true);
      return stream([SUCCESS]);
    });

    const result = await runClaudeAgentQuery({
      systemPrompt: 's',
      userPrompt: 'u',
      schema,
      isolation: 'strict',
    });

    expect(result.parsed).toEqual({ answer: 'ok' });
    const options = capturedOptions();
    expect(options).toMatchObject({
      settingSources: [],
      mcpServers: {},
      strictMcpConfig: true,
      plugins: [],
      hooks: {},
      agents: {},
      skills: [],
      persistSession: false,
      tools: [],
    });
    expect(cwdDuringQuery.startsWith(path.join(mocks.base, 'workspaces') + path.sep)).toBe(true);
    const env = options.env as Record<string, string>;
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant');
    expect(env.KYBERION_DELEGATION_DEPTH).toBeDefined();
    for (const dropped of [
      'KYBERION_PEER_SHARED_SECRET',
      'KYBERION_PEER_SHARED_SECRET_NEXT',
      'KYBERION_PROVIDER_ENV_ALLOWLIST',
      'MISSION_ID',
      'OPENAI_API_KEY',
    ]) {
      expect(env).not.toHaveProperty(dropped);
    }
    expect(Object.keys(env).filter((k) => k.startsWith('KYBERION_'))).toEqual([
      'KYBERION_DELEGATION_DEPTH',
    ]);
    expect(safeExistsSync(cwdDuringQuery)).toBe(false);
  });

  it('removes the scratch cwd when the query throws', async () => {
    let cwdDuringQuery = '';
    mocks.query.mockImplementation(({ options }: { options: { cwd: string } }) => {
      cwdDuringQuery = options.cwd;
      return {
        // eslint-disable-next-line require-yield
        async *[Symbol.asyncIterator]() {
          throw new Error('aborted');
        },
      };
    });

    await expect(
      runClaudeAgentQuery({ systemPrompt: 's', userPrompt: 'u', schema, isolation: 'strict' })
    ).rejects.toThrow('aborted');
    expect(String(cwdDuringQuery).startsWith(path.join(mocks.base, 'workspaces') + path.sep)).toBe(
      true
    );
    expect(safeExistsSync(cwdDuringQuery)).toBe(false);
  });

  it('strict isolation fails closed on a non-structured-output tool_use', async () => {
    const toolUse = (name: string) => ({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't1', name, input: {} }] },
    });
    mocks.query.mockReturnValue(stream([toolUse('Bash'), SUCCESS]));
    await expect(
      runClaudeAgentQuery({ systemPrompt: 's', userPrompt: 'u', schema, isolation: 'strict' })
    ).rejects.toMatchObject({ code: 'tool_attempt' });

    // The synthetic structured-output tool is the expected path, not an attempt.
    mocks.query.mockReturnValue(stream([toolUse('StructuredOutput'), SUCCESS]));
    await expect(
      runClaudeAgentQuery({ systemPrompt: 's', userPrompt: 'u', schema, isolation: 'strict' })
    ).resolves.toMatchObject({ parsed: { answer: 'ok' } });

    // Legacy (non-isolated) queries keep their behaviour.
    mocks.query.mockReturnValue(stream([toolUse('Bash'), SUCCESS]));
    await expect(
      runClaudeAgentQuery({ systemPrompt: 's', userPrompt: 'u', schema })
    ).resolves.toMatchObject({ parsed: { answer: 'ok' } });
  });

  it('extraOptions cannot override isolation fields', async () => {
    vi.stubEnv('KYBERION_PEER_SHARED_SECRET', 'secret-value');
    mocks.query.mockReturnValue(stream([SUCCESS]));

    await runClaudeAgentQuery({
      systemPrompt: 's',
      userPrompt: 'u',
      schema,
      isolation: 'strict',
      extraOptions: {
        settingSources: ['user', 'project', 'local'],
        cwd: '/',
        env: { ...process.env },
        mcpServers: { evil: { type: 'stdio', command: 'x' } },
        strictMcpConfig: false,
        persistSession: true,
      },
    });

    const options = capturedOptions();
    expect(options.settingSources).toEqual([]);
    expect(options.cwd).not.toBe('/');
    expect(options.mcpServers).toEqual({});
    expect(options.strictMcpConfig).toBe(true);
    expect(options.persistSession).toBe(false);
    expect(options.env).not.toHaveProperty('KYBERION_PEER_SHARED_SECRET');
  });

  it('strict isolation keeps only allowlisted extraOptions tuning keys', async () => {
    mocks.query.mockReturnValue(stream([SUCCESS]));

    await runClaudeAgentQuery({
      systemPrompt: 's',
      userPrompt: 'u',
      schema,
      isolation: 'strict',
      extraOptions: {
        extraArgs: { 'setting-sources': 'user,project' },
        projectConfigRoot: '/x',
        maxBudgetUsd: 1,
      } as Record<string, unknown>,
    });

    const options = capturedOptions();
    expect(options.maxBudgetUsd).toBe(1);
    expect(options).not.toHaveProperty('extraArgs');
    expect(options).not.toHaveProperty('projectConfigRoot');
  });

  it('without isolation the options keep their legacy shape', async () => {
    mocks.query.mockReturnValue(stream([SUCCESS]));

    await runClaudeAgentQuery({
      systemPrompt: 's',
      userPrompt: 'u',
      schema,
      extraOptions: { settingSources: ['project'], cwd: '/', env: {} },
    });

    expect(Object.keys(capturedOptions()).sort()).toEqual(
      [
        'abortController',
        'maxTurns',
        'model',
        'outputFormat',
        'permissionMode',
        'systemPrompt',
        'tools',
      ].sort()
    );
  });
});
