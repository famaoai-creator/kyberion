import { afterEach, describe, expect, it, vi } from 'vitest';
import { MissionWorkingMemory } from './mission-working-memory.js';
import {
  CARRYOVER_WORKING_MEMORY_KEY,
  WorkerContextCompactor,
  compactWorkerContext,
  compactionThresholdTokens,
  estimateContextTokens,
  isPromptTooLongError,
  loadCarryover,
  resolveContextWindowProfile,
  type CompactionCarryover,
  type CompactionEvent,
  type WorkerContextMessage,
} from './worker-context-compaction.js';

const CARRYOVER: CompactionCarryover = {
  goal: 'Ship the Q3 governance report',
  active_artifacts: ['active/missions/confidential/M1/report.md'],
  verified_state: ['T1: completed'],
  next_step: 'T4: assemble final deliverable',
};

function toolResult(content: string, pairId?: string): WorkerContextMessage {
  return { role: 'tool_result', content, pairId };
}

afterEach(() => {
  delete process.env.KYBERION_CONTEXT_WINDOW_TOKENS;
  delete process.env.KYBERION_CONTEXT_RESERVE_TOKENS;
  delete process.env.KYBERION_CONTEXT_BUFFER_TOKENS;
});

describe('worker-context-compaction (OH-01)', () => {
  it('respects env-configured window profile and threshold math', () => {
    process.env.KYBERION_CONTEXT_WINDOW_TOKENS = '10000';
    process.env.KYBERION_CONTEXT_RESERVE_TOKENS = '2000';
    process.env.KYBERION_CONTEXT_BUFFER_TOKENS = '1000';
    const profile = resolveContextWindowProfile();
    expect(profile.contextWindowTokens).toBe(10_000);
    expect(compactionThresholdTokens(profile)).toBe(7_000);
    // Explicit overrides win over env.
    expect(resolveContextWindowProfile({ contextWindowTokens: 500 }).contextWindowTokens).toBe(500);
  });

  it('does not compact below threshold', async () => {
    const result = await compactWorkerContext([toolResult('small output')], {
      profile: { contextWindowTokens: 10_000, reserveTokens: 100, bufferTokens: 100 },
    });
    expect(result.compacted).toBe(false);
    expect(result.stage).toBe('none');
    expect(result.messages[0].content).toBe('small output');
  });

  it('microcompacts old tool_results, keeps recent ones, and injects structured carryover', async () => {
    const big = 'x'.repeat(2_000);
    const messages: WorkerContextMessage[] = [
      { role: 'system', content: 'mission framing', pinned: true },
      ...Array.from({ length: 8 }, (_, i) => toolResult(`${i}:${big}`)),
    ];
    const events: CompactionEvent[] = [];
    const result = await compactWorkerContext(messages, {
      profile: { contextWindowTokens: 3_000, reserveTokens: 500, bufferTokens: 500 },
      keepRecentToolResults: 5,
      carryover: CARRYOVER,
      onEvent: (event) => events.push(event),
    });
    expect(result.compacted).toBe(true);
    expect(result.stage).toBe('microcompact');
    // First 3 of 8 tool_results elided, last 5 verbatim.
    const toolResults = result.messages.filter((m) => m.role === 'tool_result');
    expect(toolResults.slice(0, 3).every((m) => m.content.includes('elided'))).toBe(true);
    expect(toolResults.slice(3).every((m) => m.content.includes(big))).toBe(true);
    // Pinned framing untouched.
    expect(result.messages[0].content).toBe('mission framing');
    // Carryover survives as structured data (acceptance criterion 1).
    const carryoverMessage = result.messages[result.messages.length - 1];
    expect(carryoverMessage.content).toContain('<task_focus_state>');
    expect(carryoverMessage.content).toContain('goal: Ship the Q3 governance report');
    expect(carryoverMessage.content).toContain('active/missions/confidential/M1/report.md');
    expect(carryoverMessage.content).toContain('T1: completed');
    expect(carryoverMessage.content).toContain('next_step: T4: assemble final deliverable');
    // compact.before / compact.after emitted (acceptance criterion 3 hook).
    expect(events.map((e) => e.name)).toEqual(['compact.before', 'compact.after']);
    expect(events[1].attributes.tokens_after).toBeLessThan(
      events[1].attributes.tokens_before as number
    );
  });

  it('summary stage never separates a tool_use from its tool_result', async () => {
    const big = 'y'.repeat(1_500);
    const messages: WorkerContextMessage[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push({ role: 'tool_use', content: `call-${i}: ${big}`, pairId: `pair-${i}` });
      messages.push({ role: 'tool_result', content: `result-${i}: ${big}`, pairId: `pair-${i}` });
    }
    const result = await compactWorkerContext(messages, {
      profile: { contextWindowTokens: 3_000, reserveTokens: 500, bufferTokens: 500 },
      keepRecentToolResults: 0,
      summarize: async () => 'condensed history',
      recordArtifact: vi.fn(),
    });
    expect(result.stage).toBe('summary');
    // Every surviving tool_result's tool_use also survived (criterion 2).
    const survivors = result.messages;
    for (const message of survivors) {
      if (message.role !== 'tool_result' || !message.pairId) continue;
      const pairIndex = survivors.findIndex(
        (candidate) => candidate.role === 'tool_use' && candidate.pairId === message.pairId
      );
      expect(pairIndex).toBeGreaterThanOrEqual(0);
      expect(pairIndex).toBeLessThan(survivors.indexOf(message));
    }
    // Summary message present and context actually shrank.
    expect(survivors.some((m) => m.content.includes('<summary>'))).toBe(true);
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
  });

  it('persists the summary artifact under the governed tmp area and registers it', async () => {
    const big = 'z'.repeat(3_000);
    const recordArtifact = vi.fn();
    const result = await compactWorkerContext(
      Array.from({ length: 6 }, (_, i) => toolResult(`${i}:${big}`)),
      {
        profile: { contextWindowTokens: 2_000, reserveTokens: 500, bufferTokens: 500 },
        keepRecentToolResults: 1,
        missionId: 'OH1-TEST',
        summarize: async () => 'summary body',
        recordArtifact,
      }
    );
    expect(result.stage).toBe('summary');
    expect(result.summaryArtifactPath).toMatch(
      /^active\/shared\/tmp\/context-compaction\/OH1-TEST\//
    );
    expect(recordArtifact).toHaveBeenCalledWith(
      result.summaryArtifactPath,
      expect.stringContaining('compaction')
    );
  });

  it('persists carryover to mission working memory and reloads it', async () => {
    const memory = new MissionWorkingMemory();
    const missionId = 'OH1-MWM-FIXTURE';
    const big = 'w'.repeat(3_000);
    await compactWorkerContext([toolResult(big), toolResult(big)], {
      profile: { contextWindowTokens: 1_000, reserveTokens: 100, bufferTokens: 100 },
      carryover: CARRYOVER,
      missionId,
      workingMemory: memory,
      writerAgent: 'test-worker',
    });
    // Prior runs may have persisted entries for the fixture mission; assert on
    // presence + latest value rather than exact count.
    const entries = memory
      .list({ missionId, scope: 'agent' })
      .filter((entry) => entry.key === CARRYOVER_WORKING_MEMORY_KEY);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(loadCarryover(memory, missionId)).toEqual(CARRYOVER);
  });

  it('disables auto-compaction after 3 consecutive summary failures and surfaces needs_attention', async () => {
    const events: CompactionEvent[] = [];
    const compactor = new WorkerContextCompactor({
      profile: { contextWindowTokens: 1_500, reserveTokens: 200, bufferTokens: 200 },
      keepRecentToolResults: 0,
      summarize: async () => {
        throw new Error('summarizer offline');
      },
      onEvent: (event) => events.push(event),
    });
    // Small tool_results resist microcompact eliding, keeping the context over
    // threshold so the summary stage is attempted (and fails) each round.
    const filler = 'q'.repeat(150);
    const messages = Array.from({ length: 40 }, (_, i) => toolResult(`${i}:${filler}`));
    for (let round = 0; round < 3; round++) {
      const result = await compactor.maybeCompact(messages);
      expect(result.summaryError).toContain('summarizer offline');
      expect(result.stage).toBe('microcompact');
    }
    expect(compactor.isDisabled).toBe(true);
    const disabledEvent = events.find((event) => event.name === 'compact.disabled');
    expect(disabledEvent?.attributes.needs_attention).toBe(true);
    // Once disabled, no further compaction happens (acceptance criterion 4).
    const afterDisable = await compactor.maybeCompact(messages);
    expect(afterDisable.compacted).toBe(false);
  });

  it('reactively force-compacts only for prompt-too-long errors', async () => {
    expect(isPromptTooLongError(new Error('prompt is too long: 210000 tokens'))).toBe(true);
    expect(isPromptTooLongError(new Error('maximum context length exceeded'))).toBe(true);
    expect(isPromptTooLongError(new Error('rate limited'))).toBe(false);

    const compactor = new WorkerContextCompactor({
      profile: { contextWindowTokens: 1_000_000, reserveTokens: 100, bufferTokens: 100 },
      keepRecentToolResults: 1,
    });
    const messages = [toolResult('a'.repeat(5_000)), toolResult('recent')];
    expect(await compactor.compactAfterPromptTooLong(messages, new Error('boom'))).toBeNull();
    const reactive = await compactor.compactAfterPromptTooLong(
      messages,
      new Error('prompt too long')
    );
    // Forced compaction fires even though the context is far below threshold.
    expect(reactive?.compacted).toBe(true);
    expect(estimateContextTokens(reactive!.messages)).toBeLessThan(estimateContextTokens(messages));
  });
});
