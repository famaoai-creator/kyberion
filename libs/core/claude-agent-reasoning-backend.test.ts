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
    delete process.env.KYBERION_CLAUDE_NATIVE_SUBAGENT;
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

  it('exposes governed Claude delegation through the provider-neutral adopter', async () => {
    mocks.runClaudeAgentTask.mockResolvedValue({ text: 'native done', sessionId: 'claude-s1' });

    const backend = new ClaudeAgentReasoningBackend();
    const adopter = backend.getNativeSubagentAdopter?.();
    const answer = await adopter?.dispatch('inspect the task', 'mission ctx', {
      profile: 'explorer',
      effort: 'medium',
    });

    expect(answer).toBe('native done');
    expect(mocks.runClaudeAgentTask).toHaveBeenCalledTimes(1);
    const call = mocks.runClaudeAgentTask.mock.calls[0][0];
    expect(call.allowedTools).toEqual(['Read']);
    expect(call.userPrompt).toBe('Task: inspect the task');
    expect(backend.requiresNativeSubagent?.()).toBe(true);
    expect(adopter?.getInfo?.()).toMatchObject({
      provider: 'claude',
      threadId: 'claude-s1',
      // Without CN-05 native mode this is one governed agent turn, and it is
      // labeled as such rather than as a provider-native sub-agent.
      mode: 'agent-sdk-single-turn',
      effort: 'medium',
    });
  });

  describe('native SDK sub-agent mode (CN-05)', () => {
    it('passes governed agent definitions and reports the observed delegation', async () => {
      mocks.runClaudeAgentTask.mockResolvedValue({
        text: 'native done',
        sessionId: 'claude-s2',
        nativeSubagent: {
          toolUseId: 'toolu_7',
          subagentType: 'kyberion-explorer',
          background: false,
          completed: true,
        },
      });

      const backend = new ClaudeAgentReasoningBackend({ nativeSubagent: true });
      const adopter = backend.getNativeSubagentAdopter?.();
      const answer = await adopter?.dispatch('inspect it', 'mission ctx', { profile: 'explorer' });

      expect(answer).toBe('native done');
      const call = mocks.runClaudeAgentTask.mock.calls[0][0];
      expect(Object.keys(call.agents)).toEqual(['kyberion-explorer']);
      expect(call.allowedTools).toContain('Task');
      expect(call.userPrompt).toContain('run_in_background: false');
      expect(adopter?.getInfo?.()).toMatchObject({
        mode: 'agent-sdk-subagent',
        threadId: 'claude-s2',
        turnId: 'toolu_7',
        subagentType: 'kyberion-explorer',
      });
    });

    it('fails closed when the turn never started a sub-agent', async () => {
      mocks.runClaudeAgentTask.mockResolvedValue({
        text: 'I did it myself',
        sessionId: 'claude-s3',
        nativeSubagent: null,
      });

      const backend = new ClaudeAgentReasoningBackend({ nativeSubagent: true });
      const adopter = backend.getNativeSubagentAdopter?.();

      await expect(adopter?.dispatch('inspect it')).rejects.toThrow(
        '[SUBAGENT_UNAVAILABLE] Claude Agent SDK turn did not run a governed native sub-agent.'
      );
      expect(adopter?.getInfo?.()).toBeNull();
    });

    it('fails closed when the sub-agent was started but never completed', async () => {
      mocks.runClaudeAgentTask.mockResolvedValue({
        text: 'agent launched',
        sessionId: 'claude-s4',
        nativeSubagent: {
          toolUseId: 'toolu_8',
          subagentType: 'kyberion-implementer',
          background: false,
          completed: false,
        },
      });

      const backend = new ClaudeAgentReasoningBackend({ nativeSubagent: true });

      await expect(backend.getNativeSubagentAdopter()?.dispatch('build it')).rejects.toThrow(
        'did not return a completed report in this turn'
      );
    });

    it('fails closed on a background delegation whose report never reaches the turn', async () => {
      mocks.runClaudeAgentTask.mockResolvedValue({
        text: 'Agent launched in the background.',
        sessionId: 'claude-s5',
        nativeSubagent: {
          toolUseId: 'toolu_9',
          subagentType: 'kyberion-implementer',
          background: true,
          completed: false,
        },
      });

      const backend = new ClaudeAgentReasoningBackend({ nativeSubagent: true });

      await expect(backend.getNativeSubagentAdopter()?.dispatch('build it')).rejects.toThrow(
        '[SUBAGENT_UNAVAILABLE] Claude Agent SDK sub-agent "kyberion-implementer" ran in the background'
      );
    });

    it('fails closed when a non-governed built-in sub-agent ran', async () => {
      mocks.runClaudeAgentTask.mockResolvedValue({
        text: 'done',
        sessionId: 'claude-s6',
        nativeSubagent: {
          toolUseId: 'toolu_10',
          subagentType: 'general-purpose',
          background: false,
          completed: true,
        },
      });

      const backend = new ClaudeAgentReasoningBackend({ nativeSubagent: true });

      await expect(
        backend.getNativeSubagentAdopter()?.dispatch('build it', undefined, {
          profile: 'implementer',
        })
      ).rejects.toThrow(
        '[SUBAGENT_UNAVAILABLE] Claude Agent SDK turn started the non-governed sub-agent "general-purpose" instead of "kyberion-implementer".'
      );
    });

    it('fails closed when the delegation tool_result was an error', async () => {
      mocks.runClaudeAgentTask.mockResolvedValue({
        text: '',
        sessionId: 'claude-s7',
        nativeSubagent: {
          toolUseId: 'toolu_11',
          subagentType: 'kyberion-implementer',
          background: false,
          completed: false,
          failed: true,
        },
      });

      const backend = new ClaudeAgentReasoningBackend({ nativeSubagent: true });

      await expect(backend.getNativeSubagentAdopter()?.dispatch('build it')).rejects.toThrow(
        'returned a tool error'
      );
    });

    it('turns on from KYBERION_CLAUDE_NATIVE_SUBAGENT=1', async () => {
      process.env.KYBERION_CLAUDE_NATIVE_SUBAGENT = '1';
      mocks.runClaudeAgentTask.mockResolvedValue({
        text: 'ok',
        sessionId: 's',
        nativeSubagent: { toolUseId: 't', subagentType: 'kyberion-implementer', completed: true },
      });

      const backend = new ClaudeAgentReasoningBackend();
      await backend.getNativeSubagentAdopter()?.dispatch('go');

      expect(mocks.runClaudeAgentTask.mock.calls[0][0].agents).toBeDefined();
    });
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
