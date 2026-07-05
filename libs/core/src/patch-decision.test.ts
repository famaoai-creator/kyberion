import { describe, expect, it } from 'vitest';
import { computePatchDecisionScores, decidePatchAction } from '../patch-decision.js';

describe('patch-decision', () => {
  it('computes urgency and risk scores', () => {
    const scores = computePatchDecisionScores({
      severity: 3,
      reachability: 2,
      attackSurface: 1,
      semverJump: 0,
      testGap: 1,
      rollbackDifficulty: 0,
    });
    expect(scores.urgencyScore).toBe(9);
    expect(scores.applyRiskScore).toBe(1);
  });

  it('returns the expected matrix decisions', () => {
    expect(
      decidePatchAction({
        severity: 3,
        reachability: 2,
        attackSurface: 2,
        semverJump: 0,
        testGap: 0,
        rollbackDifficulty: 0,
      }).decision
    ).toBe('auto_apply');

    expect(
      decidePatchAction({
        severity: 3,
        reachability: 2,
        attackSurface: 2,
        semverJump: 2,
        testGap: 1,
        rollbackDifficulty: 2,
      }).decision
    ).toBe('urgent_approval');

    expect(
      decidePatchAction({
        severity: 0,
        reachability: 0,
        attackSurface: 1,
        semverJump: 3,
        testGap: 3,
        rollbackDifficulty: 2,
      }).decision
    ).toBe('defer');

    expect(
      decidePatchAction({
        severity: 1,
        reachability: 1,
        attackSurface: 1,
        semverJump: 1,
        testGap: 1,
        rollbackDifficulty: 1,
      }).decision
    ).toBe('scheduled');
  });
});
