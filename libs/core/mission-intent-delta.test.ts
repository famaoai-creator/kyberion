import { beforeEach, describe, expect, it, vi } from 'vitest';

// SO-01: mission-intent-delta.ts now imports these directly from their
// libs/core sibling modules (not the @agent/core barrel) — the mocks must
// target the same specifiers or vitest won't intercept the real calls.
vi.mock('./intent-snapshot-store.js', () => ({
  emitIntentSnapshot: vi.fn(),
  evaluateIntentDriftGate: vi.fn(),
  mapStageToLoopPhase: vi.fn((stage: string) => stage),
}));
vi.mock('./intent-extractor.js', () => ({
  getIntentExtractor: vi.fn(),
}));
vi.mock('./core.js', () => ({
  logger: { warn: vi.fn() },
}));

import { emitIntentSnapshot, evaluateIntentDriftGate } from './intent-snapshot-store.js';
import { getIntentExtractor } from './intent-extractor.js';
import {
  emitMissionLifecycleIntentSnapshot,
  evaluateMissionIntentDrift,
} from './mission-intent-delta.js';

describe('mission-intent-delta hooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits lifecycle snapshot using extractor output when text is available', async () => {
    vi.mocked(getIntentExtractor).mockReturnValue({
      name: 'fake',
      extract: vi.fn(async () => ({ goal: 'parsed goal' })),
    } as any);

    await emitMissionLifecycleIntentSnapshot({
      missionId: 'MSN-T1',
      stage: 'execution',
      text: 'please execute',
      source: 'user_prompt',
      traceRef: 'corr-mission-intent-001',
    });

    expect(emitIntentSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: 'MSN-T1',
        stage: 'execution',
        source: 'user_prompt',
        traceRef: 'corr-mission-intent-001',
        intent: { goal: 'parsed goal' },
      })
    );
  });

  it('uses a deterministic local summary for mission_state text', async () => {
    const extract = vi.fn(async () => ({ goal: 'parsed goal' }));
    vi.mocked(getIntentExtractor).mockReturnValue({
      name: 'fake',
      extract,
    } as any);

    await emitMissionLifecycleIntentSnapshot({
      missionId: 'MSN-T3',
      stage: 'execution',
      text: '**goal**: Extended adaptive retry rollout',
      source: 'mission_state',
    });

    expect(extract).not.toHaveBeenCalled();
    expect(emitIntentSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: 'MSN-T3',
        stage: 'execution',
        source: 'mission_state',
        intent: { goal: '**goal**: Extended adaptive retry rollout' },
      })
    );
  });

  it('returns a normalized drift summary', () => {
    vi.mocked(evaluateIntentDriftGate).mockReturnValue({
      passed: true,
      verdict: 'minor',
      driftScore: 0.2,
      delta: null,
      message: 'ok',
    } as any);

    const summary = evaluateMissionIntentDrift('MSN-T2');
    expect(summary?.passed).toBe(true);
    expect(summary?.verdict).toBe('minor');
    expect(summary?.drift_score).toBe(0.2);
  });
});
