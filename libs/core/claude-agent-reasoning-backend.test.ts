import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runClaudeAgentQuery: vi.fn(),
  runClaudeAgentTask: vi.fn(),
}));

vi.mock('./claude-agent-query.js', () => ({
  runClaudeAgentQuery: mocks.runClaudeAgentQuery,
  runClaudeAgentTask: mocks.runClaudeAgentTask,
  ClaudeAgentQueryError: class ClaudeAgentQueryError extends Error {},
}));

vi.mock('./claude-agent-governance.js', () => ({
  GOVERNED_AGENT_ALLOWED_TOOLS: ['Read'],
  buildGovernedAgentSystemPrompt: vi.fn(({ base }: { base: string }) => base),
  buildKyberionMcpServerConfig: vi.fn(() => ({})),
  createKyberionCanUseTool: vi.fn(() => () => ({ behavior: 'allow' })),
}));

import { ClaudeAgentReasoningBackend } from './claude-agent-reasoning-backend.js';

describe('ClaudeAgentReasoningBackend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.KYBERION_CLAUDE_AGENT_TOOLS;
  });

  it('shapes divergePersonas requests and normalizes hypothesis status', async () => {
    mocks.runClaudeAgentQuery.mockResolvedValue({
      parsed: {
        hypotheses: [
          { id: 'H-ceo-1', proposed_by: 'ceo', content: 'Ship weekly.' },
          { id: 'H-cfo-1', proposed_by: 'cfo', content: 'Cut burn.', status: 'survived' },
        ],
      },
    });

    const backend = new ClaudeAgentReasoningBackend({ model: 'sonnet' });
    const hypotheses = await backend.divergePersonas({
      topic: 'release cadence',
      personas: ['ceo', 'cfo'],
      minPerPersona: 1,
    });

    expect(mocks.runClaudeAgentQuery).toHaveBeenCalledTimes(1);
    const call = mocks.runClaudeAgentQuery.mock.calls[0][0];
    expect(call.model).toBe('sonnet');
    expect(call.userPrompt).toContain('release cadence');
    expect(call.userPrompt).toContain('ceo, cfo');
    expect(call.systemPrompt).toContain('judgment-support reasoning engine');
    // Missing status defaults to pending; explicit status is preserved.
    expect(hypotheses[0].status).toBe('pending');
    expect(hypotheses[1].status).toBe('survived');
  });

  it('defaults the model to opus and passes crossCritique hypotheses through', async () => {
    const critique = {
      hypotheses: [{ id: 'H-1', proposed_by: 'ceo', content: 'x', survived: true }],
    };
    mocks.runClaudeAgentQuery.mockResolvedValue({ parsed: critique });

    const backend = new ClaudeAgentReasoningBackend();
    const result = await backend.crossCritique({
      topic: 't',
      personas: ['ceo'],
      hypotheses: [{ id: 'H-1', proposed_by: 'ceo', content: 'x', status: 'pending' }],
    });

    expect(mocks.runClaudeAgentQuery.mock.calls[0][0].model).toBe('opus');
    expect(result).toEqual(critique);
  });

  it('delegateTask uses the pure single-turn query path by default', async () => {
    mocks.runClaudeAgentQuery.mockResolvedValue({ parsed: { answer: '42' } });

    const backend = new ClaudeAgentReasoningBackend();
    const answer = await backend.delegateTask('compute', 'mission ctx');

    expect(answer).toBe('42');
    expect(mocks.runClaudeAgentTask).not.toHaveBeenCalled();
    const call = mocks.runClaudeAgentQuery.mock.calls[0][0];
    expect(call.userPrompt).toContain('Task: compute');
    expect(call.userPrompt).toContain('Context: mission ctx');
  });

  it('delegateTask switches to the governed agentic path when opted in', async () => {
    process.env.KYBERION_CLAUDE_AGENT_TOOLS = '1';
    mocks.runClaudeAgentTask.mockResolvedValue({ text: 'done via tools' });

    const backend = new ClaudeAgentReasoningBackend();
    const answer = await backend.delegateTask('do work');

    expect(answer).toBe('done via tools');
    expect(mocks.runClaudeAgentQuery).not.toHaveBeenCalled();
    const call = mocks.runClaudeAgentTask.mock.calls[0][0];
    expect(call.allowedTools).toEqual(['Read']);
    expect(call.userPrompt).toBe('Task: do work');
  });

  it('propagates transport errors without swallowing them', async () => {
    mocks.runClaudeAgentQuery.mockRejectedValue(new Error('rate_limited: 429'));

    const backend = new ClaudeAgentReasoningBackend();
    await expect(
      backend.crossCritique({ topic: 't', personas: ['a'], hypotheses: [] })
    ).rejects.toThrow('rate_limited: 429');
  });

  it('prompt() is an alias of delegateTask', async () => {
    mocks.runClaudeAgentQuery.mockResolvedValue({ parsed: { answer: 'aliased' } });

    const backend = new ClaudeAgentReasoningBackend();
    await expect(backend.prompt('hello')).resolves.toBe('aliased');
  });
});
