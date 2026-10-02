import { beforeEach, describe, expect, it, vi } from 'vitest';

// SO-01: mission-intent-delta.ts now imports these directly from their
// libs/core sibling modules (not the @agent/core barrel) — the mocks must
// target the same specifiers or vitest won't intercept the real calls.
vi.mock('../intent/intent-snapshot-store.js', () => ({
  emitIntentSnapshot: vi.fn(),
  evaluateIntentDriftGate: vi.fn(),
  mapStageToLoopPhase: vi.fn((stage: string) => stage),
}));
vi.mock('../intent/intent-extractor.js', () => ({
  getIntentExtractor: vi.fn(),
}));
vi.mock('./mission-state.js', () => ({
  loadState: vi.fn(() => null),
}));
vi.mock('../core.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn() },
}));

import { emitIntentSnapshot, evaluateIntentDriftGate } from '../intent/intent-snapshot-store.js';
import { getIntentExtractor } from '../intent/intent-extractor.js';
import { loadState } from './mission-state.js';
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

  it('mission_state snapshots carry the canonical intent, not the caller note', async () => {
    // Regression: a verify/finish note recorded as the snapshot goal was
    // summarized to ~200 chars while the approved origin kept the full goal —
    // the Jaccard mismatch re-blocked the finish gate after a legitimate
    // scope-approve (MSN-RESIDENT-DOT-20261002, drift 0.753→0.813).
    vi.mocked(loadState).mockReturnValue({
      intent: {
        goal_summary: 'Restore autonomous-ops alert paths and land the Dot charter foundation.',
      },
      outcome_contract: {
        success_criteria: ['schedules pass', 'watchdog clean'],
        expected_artifacts: [{ kind: 'doc' }],
      },
      relationships: { project: { project_id: 'PRJ-1' } },
    } as any);

    await emitMissionLifecycleIntentSnapshot({
      missionId: 'MSN-T4',
      stage: 'verification',
      text: 'unrelated verification note that must not become the goal',
      source: 'mission_state',
    });

    expect(emitIntentSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: 'MSN-T4',
        source: 'mission_state',
        intent: {
          goal: 'Restore autonomous-ops alert paths and land the Dot charter foundation.',
          constraints: ['schedules pass', 'watchdog clean'],
          deliverables: ['doc'],
          stakeholders: ['PRJ-1'],
        },
      })
    );
  });

  it('falls back to the caller text when mission state is absent', async () => {
    vi.mocked(loadState).mockReturnValue(null);

    await emitMissionLifecycleIntentSnapshot({
      missionId: 'MSN-T5',
      stage: 'verification',
      text: 'verify note',
      source: 'mission_state',
    });

    expect(emitIntentSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: 'MSN-T5',
        intent: { goal: 'verify note' },
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
