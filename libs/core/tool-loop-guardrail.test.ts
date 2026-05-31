import { describe, expect, it } from 'vitest';
import { advanceToolLoopGuardrail, createToolLoopGuardrailState, normalizeToolCallSignature } from './tool-loop-guardrail.js';

describe('tool-loop guardrail', () => {
  it('normalizes tool arguments before comparing signatures', () => {
    const first = normalizeToolCallSignature({
      name: 'read_file',
      arguments: JSON.stringify({ path: 'README.md', mode: 'text' }),
    });
    const second = normalizeToolCallSignature({
      name: 'read_file',
      arguments: JSON.stringify({ mode: 'text', path: 'README.md' }),
    });

    expect(first).toBe(second);
  });

  it('stops repeated identical tool calls before another loop round', () => {
    const initial = createToolLoopGuardrailState();
    const first = advanceToolLoopGuardrail(initial, { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) });
    const second = advanceToolLoopGuardrail(first.state, { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) });
    const third = advanceToolLoopGuardrail(second.state, { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) });

    expect(first.shouldStop).toBe(false);
    expect(second.shouldStop).toBe(false);
    expect(third.shouldStop).toBe(true);
    expect(third.reason).toContain('repeated calls to read_file');
  });

  it('stops long tool loops even when the tool name changes', () => {
    let state = createToolLoopGuardrailState();
    let decision = advanceToolLoopGuardrail(state, { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) }, { maxTotalCalls: 2, maxConsecutiveSameCalls: 99 });
    state = decision.state;
    decision = advanceToolLoopGuardrail(state, { name: 'list_directory', arguments: JSON.stringify({ path: '.' }) }, { maxTotalCalls: 2, maxConsecutiveSameCalls: 99 });
    state = decision.state;
    decision = advanceToolLoopGuardrail(state, { name: 'shell_exec', arguments: JSON.stringify({ command: 'pwd' }) }, { maxTotalCalls: 2, maxConsecutiveSameCalls: 99 });

    expect(decision.shouldStop).toBe(true);
    expect(decision.reason).toContain('without reaching a final answer');
  });
});
