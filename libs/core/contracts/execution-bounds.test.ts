import { describe, expect, it } from 'vitest';
import {
  assertExecutionBounds,
  createExecutionBoundsState,
  withinLoopBounds,
  DEFAULT_MAX_PIPELINE_STEPS,
  DEFAULT_MAX_LOOP_ITERATIONS,
} from './execution-bounds.js';

describe('execution-bounds', () => {
  it('passes while under the step and time limits', () => {
    const state = createExecutionBoundsState(1_000);
    state.stepCount = 5;
    expect(() => assertExecutionBounds(state, {}, 1_500)).not.toThrow();
  });

  it('throws the historical SAFETY_LIMIT message when steps exceed the bound', () => {
    const state = createExecutionBoundsState(1_000);
    state.stepCount = DEFAULT_MAX_PIPELINE_STEPS + 1;
    expect(() => assertExecutionBounds(state, {}, 1_500)).toThrow(
      `[SAFETY_LIMIT] Exceeded maximum pipeline steps (${DEFAULT_MAX_PIPELINE_STEPS})`
    );
  });

  it('throws on wall-clock timeout', () => {
    const state = createExecutionBoundsState(1_000);
    state.stepCount = 1;
    expect(() => assertExecutionBounds(state, { timeoutMs: 500 }, 2_000)).toThrow(
      '[SAFETY_LIMIT] Pipeline execution timed out (500ms)'
    );
  });

  it('honors custom maxSteps', () => {
    const state = createExecutionBoundsState(0);
    state.stepCount = 3;
    expect(() => assertExecutionBounds(state, { maxSteps: 2 }, 1)).toThrow('(2)');
    expect(() => assertExecutionBounds(state, { maxSteps: 3 }, 1)).not.toThrow();
  });

  it('loop bounds default to the shared limit', () => {
    expect(withinLoopBounds(DEFAULT_MAX_LOOP_ITERATIONS - 1)).toBe(true);
    expect(withinLoopBounds(DEFAULT_MAX_LOOP_ITERATIONS)).toBe(false);
    expect(withinLoopBounds(4, 5)).toBe(true);
    expect(withinLoopBounds(5, 5)).toBe(false);
  });
});
