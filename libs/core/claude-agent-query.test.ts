import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mocks.query }));
vi.mock('./reasoning-egress-scope.js', () => ({ assertReasoningEgressAllowed: vi.fn() }));
vi.mock('./metrics.js', () => ({
  metrics: { record: vi.fn(), increment: vi.fn(), observe: vi.fn() },
}));

import { runClaudeAgentTask } from './claude-agent-query.js';

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
});
