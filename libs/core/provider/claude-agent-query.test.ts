import { z } from 'zod';
import { runInExecutionScope } from '../foundation/execution-scope.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mocks.query }));
vi.mock('../reasoning/reasoning-egress-scope.js', () => ({
  assertReasoningEgressAllowed: vi.fn(),
}));
vi.mock('../metrics.js', () => ({
  metrics: { record: vi.fn(), increment: vi.fn(), observe: vi.fn() },
}));

import { runClaudeAgentTask, runClaudeAgentQuery } from './claude-agent-query.js';
import { metrics } from '../metrics.js';

function stream(messages: Record<string, unknown>[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const message of messages) yield message;
    },
  };
}

const SUCCESS = {
  type: 'result',
  subtype: 'success',
  result: 'REPORT',
  session_id: 'sess-1',
  total_cost_usd: 0.01,
  num_turns: 2,
};

describe('runClaudeAgentTask native sub-agent observation (CN-05)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps SDK API-equivalent prices reference-only and missing telemetry unknown', async () => {
    mocks.query.mockReturnValueOnce(
      stream([{ ...SUCCESS, usage: { input_tokens: 10, output_tokens: 3 } }])
    );
    await runClaudeAgentTask({ systemPrompt: 's', userPrompt: 'u' });
    const first = vi.mocked(metrics.record).mock.calls[0][3];
    expect(first).toMatchObject({
      billing_mode: 'unknown',
      usage_source: 'provider',
      reference_cost_usd: 0.01,
      cause: 'subagent',
    });
    expect(first).not.toHaveProperty('sdk_cost_usd');
    expect(first).not.toHaveProperty('reported_cost_usd');
    mocks.query.mockReturnValueOnce(stream([{ type: 'result', subtype: 'success', result: 'ok' }]));
    await runClaudeAgentTask({ systemPrompt: 's', userPrompt: 'u' });
    const second = vi.mocked(metrics.record).mock.calls[1][3];
    expect(second).toMatchObject({ cost_status: 'unknown', usage_source: 'unknown' });
    expect(second).not.toHaveProperty('usage');
    expect(second).not.toHaveProperty('reference_cost_usd');
  });

  it('reports no native delegation for an ordinary agent turn', async () => {
    mocks.query.mockReturnValue(
      stream([
        { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } },
        SUCCESS,
      ])
    );

    const result = await runClaudeAgentTask({ systemPrompt: 's', userPrompt: 'u' });

    expect(result.text).toBe('REPORT');
    expect(result.nativeSubagent).toBeNull();
  });

  function delegation(input: Record<string, unknown>): Record<string, unknown> {
    return {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Agent', id: 'toolu_3', input }],
      },
    };
  }

  function delegationResult(
    content: unknown,
    extra: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_3', content, ...extra }] },
    };
  }

  const ASYNC_LAUNCH_ACK = [
    {
      type: 'text',
      text: 'Async agent launched successfully.\nagentId: aa3c9030\nThe agent is working in the background.',
    },
  ];

  it('observes a completed delegation from the tool_use / tool_result pair', async () => {
    mocks.query.mockReturnValue(
      stream([
        delegation({ subagent_type: 'kyberion-explorer', run_in_background: false }),
        delegationResult([{ type: 'text', text: 'REPORT' }]),
        SUCCESS,
      ])
    );

    const result = await runClaudeAgentTask({ systemPrompt: 's', userPrompt: 'u' });

    expect(result.nativeSubagent).toEqual({
      toolUseId: 'toolu_3',
      subagentType: 'kyberion-explorer',
      background: false,
      completed: true,
    });
  });

  it('marks a started-but-unfinished delegation as incomplete', async () => {
    mocks.query.mockReturnValue(
      stream([
        delegation({ subagent_type: 'kyberion-implementer', run_in_background: false }),
        SUCCESS,
      ])
    );

    const result = await runClaudeAgentTask({ systemPrompt: 's', userPrompt: 'u' });

    expect(result.nativeSubagent).toMatchObject({ toolUseId: 'toolu_3', completed: false });
  });

  it('does not treat the background launch acknowledgement as completion', async () => {
    mocks.query.mockReturnValue(
      stream([
        delegation({ subagent_type: 'kyberion-explorer', run_in_background: true }),
        delegationResult(ASYNC_LAUNCH_ACK),
        // A background sub-agent still emits scoped messages — they are not proof.
        { type: 'assistant', parent_tool_use_id: 'toolu_3', message: { content: [] } },
        SUCCESS,
      ])
    );

    const result = await runClaudeAgentTask({ systemPrompt: 's', userPrompt: 'u' });

    expect(result.nativeSubagent).toMatchObject({ background: true, completed: false });
  });

  it('does not treat an errored tool_result as completion', async () => {
    mocks.query.mockReturnValue(
      stream([
        delegation({ subagent_type: 'kyberion-explorer', run_in_background: false }),
        delegationResult([{ type: 'text', text: 'denied' }], { is_error: true }),
        SUCCESS,
      ])
    );

    const result = await runClaudeAgentTask({ systemPrompt: 's', userPrompt: 'u' });

    expect(result.nativeSubagent).toMatchObject({ failed: true, completed: false });
  });

  it('forwards agent definitions to the SDK', async () => {
    mocks.query.mockReturnValue(stream([SUCCESS]));
    const agents = { 'kyberion-explorer': { description: 'd', prompt: 'p', tools: ['Read'] } };

    await runClaudeAgentTask({ systemPrompt: 's', userPrompt: 'u', agents });

    expect(mocks.query.mock.calls[0][0].options.agents).toBe(agents);
  });

  it('does not allow extraOptions to override the governed task surface', async () => {
    mocks.query.mockReturnValue(stream([SUCCESS]));
    const canUseTool = vi.fn();
    const rogueCanUseTool = vi.fn();
    const agents = { 'kyberion-explorer': { description: 'd', prompt: 'p', tools: ['Read'] } };

    await runClaudeAgentTask({
      systemPrompt: 'governed system',
      userPrompt: 'u',
      model: 'sonnet',
      maxTurns: 2,
      allowedTools: ['Read'],
      canUseTool,
      agents,
      extraOptions: {
        systemPrompt: 'rogue system',
        model: 'haiku',
        maxTurns: 99,
        permissionMode: 'bypassPermissions',
        tools: ['Bash'],
        allowedTools: ['Bash'],
        canUseTool: rogueCanUseTool,
        agents: { 'general-purpose': { description: 'rogue', prompt: 'rogue' } },
        mcpServers: { evil: { type: 'stdio', command: 'evil', args: [] } },
      } as any,
    });

    const options = mocks.query.mock.calls[0][0].options;
    expect(options).toMatchObject({
      systemPrompt: 'governed system',
      model: 'sonnet',
      maxTurns: 2,
      permissionMode: 'default',
      allowedTools: ['Read'],
      canUseTool,
      agents,
    });
    expect(options.tools).toBeUndefined();
    expect(options.mcpServers).toBeUndefined();
  });
});

it('fails closed before the Agent SDK can inherit an operator environment under a tenant', async () => {
  mocks.query.mockClear();
  await runInExecutionScope({ tenantBound: true, tenantSlug: 'sdk-native-fixture' }, async () => {
    await expect(
      runClaudeAgentTask({ systemPrompt: 'system', userPrompt: 'must not send' })
    ).rejects.toThrow('CREDENTIAL_NATIVE_UNSUPPORTED');
    for (const isolation of [undefined, 'strict'] as const)
      await expect(
        runClaudeAgentQuery({
          systemPrompt: 'system',
          userPrompt: 'must not send',
          schema: z.object({ ok: z.boolean() }),
          ...(isolation ? { isolation } : {}),
        })
      ).rejects.toThrow('CREDENTIAL_NATIVE_UNSUPPORTED');
  });
  expect(mocks.query).not.toHaveBeenCalled();
});
