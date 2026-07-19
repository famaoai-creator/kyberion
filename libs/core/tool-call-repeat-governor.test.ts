import { describe, expect, it } from 'vitest';
import {
  advanceToolCallRepeatGovernor,
  buildToolCallRepeatForceStopMessage,
  canonicalizeToolCallArgs,
  createToolCallRepeatGovernorState,
  hydrateToolCallRepeatGovernorState,
  encodeToolCallRepeatGovernorState,
} from './tool-call-repeat-governor.js';

function advanceTimes(
  count: number,
  tool: string,
  args: unknown,
  state = createToolCallRepeatGovernorState()
) {
  let current = state;
  let decision;
  for (let i = 0; i < count; i += 1) {
    decision = advanceToolCallRepeatGovernor(current, tool, args);
    current = decision.state;
  }
  return decision!;
}

describe('canonicalizeToolCallArgs', () => {
  it('collides semantically identical args regardless of key order', () => {
    expect(canonicalizeToolCallArgs({ b: 1, a: { d: 2, c: [3, 4] } })).toBe(
      canonicalizeToolCallArgs({ a: { c: [3, 4], d: 2 }, b: 1 })
    );
  });

  it('keeps array order significant', () => {
    expect(canonicalizeToolCallArgs({ list: [1, 2] })).not.toBe(
      canonicalizeToolCallArgs({ list: [2, 1] })
    );
  });

  it('degrades to String() for non-serializable values', () => {
    const circular: any = {};
    circular.self = circular;
    expect(() => canonicalizeToolCallArgs(circular)).not.toThrow();
  });
});

describe('advanceToolCallRepeatGovernor', () => {
  it('escalates at 3 (gentle), 5 (detailed), 8 (dead_end) and force-stops at 12', () => {
    let state = createToolCallRepeatGovernorState();
    const escalations: string[] = [];
    for (let i = 1; i <= 12; i += 1) {
      const decision = advanceToolCallRepeatGovernor(state, 'shell:exec', { cmd: 'ls' });
      state = decision.state;
      escalations.push(decision.escalation);
      if (i < 12) expect(decision.should_force_stop).toBe(false);
    }
    expect(escalations[2]).toBe('gentle');
    expect(escalations[4]).toBe('detailed');
    expect(escalations[7]).toBe('dead_end');
    expect(escalations[11]).toBe('force_stop');
    expect(escalations[3]).toBe('none');
    expect(escalations[8]).toBe('none');
  });

  it('resets the streak when a different call interleaves', () => {
    let state = createToolCallRepeatGovernorState();
    for (let i = 0; i < 2; i += 1) {
      state = advanceToolCallRepeatGovernor(state, 'a', { x: 1 }).state;
    }
    state = advanceToolCallRepeatGovernor(state, 'b', { x: 1 }).state;
    const decision = advanceToolCallRepeatGovernor(state, 'a', { x: 1 });
    expect(decision.streak).toBe(1);
    expect(decision.state.total_calls).toBe(4);
  });

  it('treats key order and formatting differences as the same call', () => {
    let state = createToolCallRepeatGovernorState();
    state = advanceToolCallRepeatGovernor(state, 'a', { x: 1, y: 2 }).state;
    const decision = advanceToolCallRepeatGovernor(state, 'a', { y: 2, x: 1 });
    expect(decision.streak).toBe(2);
  });

  it('provides reminders only at exact escalation thresholds', () => {
    const at3 = advanceTimes(3, 'a', {});
    const at4 = advanceTimes(4, 'a', {});
    expect(at3.reminder).toContain('identical arguments');
    expect(at4.reminder).toBeUndefined();
  });
});

describe('state encode/hydrate', () => {
  it('round-trips and rejects malformed metadata', () => {
    const decision = advanceTimes(5, 'a', { z: 1 });
    const restored = hydrateToolCallRepeatGovernorState(
      encodeToolCallRepeatGovernorState(decision.state)
    );
    expect(restored).toEqual(decision.state);
    expect(hydrateToolCallRepeatGovernorState(null)).toEqual(createToolCallRepeatGovernorState());
    expect(hydrateToolCallRepeatGovernorState({ streak: -4, total_calls: 'x' })).toEqual(
      createToolCallRepeatGovernorState()
    );
  });
});

describe('buildToolCallRepeatForceStopMessage', () => {
  it('carries both the safety-limit and repeat tags', () => {
    const message = buildToolCallRepeatForceStopMessage('apply:notify', 12);
    expect(message).toContain('[SAFETY_LIMIT]');
    expect(message).toContain('[TOOL_CALL_REPEAT]');
    expect(message).toContain('apply:notify');
  });
});
