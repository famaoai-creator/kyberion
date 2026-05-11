import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@agent/core', () => ({
  emitIntentSnapshot: vi.fn(),
  evaluateIntentDriftGate: vi.fn(),
  getIntentExtractor: vi.fn(),
  logger: { warn: vi.fn() },
  mapStageToLoopPhase: vi.fn((stage: string) => stage),
}));

import {
  emitIntentSnapshot,
  evaluateIntentDriftGate,
  getIntentExtractor,
} from '@agent/core';
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
    });

    expect(emitIntentSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: 'MSN-T1',
        stage: 'execution',
        source: 'user_prompt',
        intent: { goal: 'parsed goal' },
      }),
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
      }),
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
