import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THRESHOLDS,
  classifyDrift,
  computeIntentDelta,
  goalSimilarity,
  isBlockingDrift,
  type IntentSnapshot,
} from './intent-delta.js';

function snap(
  overrides: Partial<IntentSnapshot> & { goal: string; id?: string },
): IntentSnapshot {
  const { id = 'snap-x', goal, ...rest } = overrides;
  return {
    snapshot_id: id,
    mission_id: 'MSN-TEST',
    stage: 'execute',
    created_at: '2026-04-20T00:00:00Z',
    source: 'manual',
    intent: { goal, ...((rest as any).intent ?? {}) },
    ...((rest as any).trace_ref ? { trace_ref: (rest as any).trace_ref } : {}),
  };
}

describe('intent-delta', () => {
  describe('goalSimilarity', () => {
    it('returns 1.0 for identical goals', () => {
      expect(goalSimilarity('prepare quarterly report', 'prepare quarterly report')).toBe(1);
    });

    it('returns 1.0 for two empty strings', () => {
      expect(goalSimilarity('', '')).toBe(1);
    });

    it('falls below 1 when tokens differ', () => {
      expect(goalSimilarity('prepare report', 'prepare deck')).toBeLessThan(1);
    });

    it('is close to zero for fully disjoint goals', () => {
      const sim = goalSimilarity('refactor payment adapter', 'write marketing blog');
      expect(sim).toBeLessThanOrEqual(0.1);
    });

    it('ignores punctuation and case', () => {
      expect(goalSimilarity('Prepare, the Q4 Report.', 'prepare the q4 report')).toBe(1);
    });
  });

  describe('classifyDrift', () => {
    it('returns none below the minor threshold', () => {
      expect(classifyDrift(0.05)).toBe('none');
    });

    it('returns minor between minor and significant', () => {
      expect(classifyDrift(0.2)).toBe('minor');
    });

    it('returns significant between significant and blocking', () => {
      expect(classifyDrift(0.4)).toBe('significant');
    });

    it('returns blocking at or above blocking threshold', () => {
      expect(classifyDrift(DEFAULT_THRESHOLDS.blocking)).toBe('blocking');
      expect(classifyDrift(0.9)).toBe('blocking');
    });
  });

  describe('computeIntentDelta', () => {
    it('reports no drift when snapshots are identical', () => {
      const a = snap({ id: 'a', goal: 'ship release 1.0' });
      const b = snap({ id: 'b', goal: 'ship release 1.0' });
      const delta = computeIntentDelta(a, b);
      expect(delta.changes.goal_changed).toBe(false);
      expect(delta.drift_score).toBe(0);
      expect(delta.drift_verdict).toBe('none');
      expect(isBlockingDrift(delta)).toBe(false);
    });

    it('detects goal drift and classifies it', () => {
      const from = snap({ id: 'a', goal: 'refactor payment adapter' });
      const to = snap({ id: 'b', goal: 'write marketing blog' });
      const delta = computeIntentDelta(from, to);
      expect(delta.changes.goal_changed).toBe(true);
      expect(delta.drift_score).toBeGreaterThanOrEqual(DEFAULT_THRESHOLDS.blocking);
      expect(delta.drift_verdict).toBe('blocking');
      expect(isBlockingDrift(delta)).toBe(true);
    });

    it('reports added and removed constraints', () => {
      const from = {
        ...snap({ id: 'a', goal: 'ship release 1.0' }),
        intent: { goal: 'ship release 1.0', constraints: ['by Friday'] },
      };
      const to = {
        ...snap({ id: 'b', goal: 'ship release 1.0' }),
        intent: { goal: 'ship release 1.0', constraints: ['under budget'] },
      };
      const delta = computeIntentDelta(from, to);
      expect(delta.changes.constraints_added).toEqual(['under budget']);
      expect(delta.changes.constraints_removed).toEqual(['by Friday']);
      expect(delta.drift_verdict).not.toBe('none');
    });

    it('captures stakeholder additions without touching the goal', () => {
      const from = {
        ...snap({ id: 'a', goal: 'build consensus for new org chart' }),
        intent: { goal: 'build consensus for new org chart', stakeholders: ['alice'] },
      };
      const to = {
        ...snap({ id: 'b', goal: 'build consensus for new org chart' }),
        intent: { goal: 'build consensus for new org chart', stakeholders: ['alice', 'bob'] },
      };
      const delta = computeIntentDelta(from, to);
      expect(delta.changes.goal_changed).toBe(false);
      expect(delta.changes.stakeholders_added).toEqual(['bob']);
      expect(delta.drift_verdict).toBe('minor');
    });

    it('refuses to compare snapshots from different missions', () => {
      const a = snap({ id: 'a', goal: 'x' });
      const b: IntentSnapshot = {
        snapshot_id: 'b',
        mission_id: 'OTHER-MSN',
        stage: 'execute',
        created_at: '2026-04-20T00:00:00Z',
        source: 'manual',
        intent: { goal: 'x' },
      };
      expect(() => computeIntentDelta(a, b)).toThrow(/cross-mission/);
    });
  });
});
