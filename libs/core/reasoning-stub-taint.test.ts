import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getReasoningBackend,
  getStubServedOps,
  resetReasoningBackend,
  resetStubServedOps,
} from './reasoning-backend.js';
import { reconcileCompletionStructurally } from './intent-reconciliation.js';

const GOAL_INPUT = {
  goal: {
    summary: 'produce the report',
    success_condition: 'report delivered',
  },
  evidenceTexts: ['report delivered'],
};

describe('stub taint gate (LC-07)', () => {
  let savedMode: string | undefined;

  beforeEach(() => {
    savedMode = process.env.KYBERION_REASONING_BACKEND;
    delete process.env.KYBERION_REASONING_BACKEND;
    resetReasoningBackend();
  });

  afterEach(() => {
    if (savedMode === undefined) delete process.env.KYBERION_REASONING_BACKEND;
    else process.env.KYBERION_REASONING_BACKEND = savedMode;
    resetReasoningBackend();
  });

  it('records stub-served ops', async () => {
    expect(getStubServedOps()).toHaveLength(0);
    await getReasoningBackend().delegateTask('do something');
    await getReasoningBackend().decomposeIntoTasks({ designDraft: {} });
    const served = getStubServedOps();
    expect(served.map((entry) => entry.op)).toEqual(['delegateTask', 'decomposeIntoTasks']);
  });

  it('blocks completion when stub ops were served without explicit stub mode', async () => {
    await getReasoningBackend().delegateTask('fabricate a judgment');
    const result = reconcileCompletionStructurally(GOAL_INPUT);
    expect(result.satisfied).toBe(false);
    expect(result.gaps.some((gap) => gap.includes('reasoning_stub_served'))).toBe(true);
    expect(result.confidence).toBeLessThanOrEqual(0.2);
  });

  it('does not block completion in explicit stub mode', async () => {
    process.env.KYBERION_REASONING_BACKEND = 'stub';
    await getReasoningBackend().delegateTask('deterministic test judgment');
    const result = reconcileCompletionStructurally(GOAL_INPUT);
    expect(result.gaps.some((gap) => gap.includes('reasoning_stub_served'))).toBe(false);
    expect(result.satisfied).toBe(true);
  });

  it('does not block completion when no stub op ran', () => {
    const result = reconcileCompletionStructurally(GOAL_INPUT);
    expect(result.satisfied).toBe(true);
    expect(result.gaps).toHaveLength(0);
  });

  it('resetReasoningBackend clears the taint registry', async () => {
    await getReasoningBackend().prompt('hello');
    expect(getStubServedOps().length).toBeGreaterThan(0);
    resetReasoningBackend();
    expect(getStubServedOps()).toHaveLength(0);
  });

  it('resetStubServedOps clears taint without touching registration', async () => {
    await getReasoningBackend().prompt('hello');
    resetStubServedOps();
    expect(getStubServedOps()).toHaveLength(0);
  });
});
