import { describe, expect, it } from 'vitest';
import {
  computePatchDecisionScores,
  decidePatchAction,
  type PatchDecisionInput,
} from './patch-decision.js';

function input(overrides: Partial<PatchDecisionInput>): PatchDecisionInput {
  return {
    severity: 0,
    reachability: 0,
    attackSurface: 0,
    semverJump: 0,
    testGap: 0,
    rollbackDifficulty: 0,
    ...overrides,
  };
}

describe('computePatchDecisionScores', () => {
  it('weights severity double in the urgency score', () => {
    const scores = computePatchDecisionScores(
      input({ severity: 3, reachability: 2, attackSurface: 1 })
    );
    expect(scores.urgencyScore).toBe(9);
  });

  it('clamps out-of-range and non-finite inputs to [0, 3]', () => {
    const scores = computePatchDecisionScores(
      input({
        severity: 99,
        reachability: -5,
        attackSurface: Number.NaN,
        semverJump: 10,
        testGap: Number.POSITIVE_INFINITY,
        rollbackDifficulty: 3.9,
      })
    );
    expect(scores.urgencyScore).toBe(6); // 3*2 + 0 + 0
    expect(scores.applyRiskScore).toBe(6); // 3 + 0 + 3
  });
});

describe('decidePatchAction (§3.3 matrix quadrants)', () => {
  it('high urgency × low risk → auto_apply', () => {
    const result = decidePatchAction(
      input({ severity: 3, reachability: 2, attackSurface: 0, testGap: 1 })
    );
    expect(result.decision).toBe('auto_apply');
    expect(result.urgencyScore).toBe(8);
    expect(result.applyRiskScore).toBe(1);
  });

  it('high urgency × high risk → urgent_approval', () => {
    const result = decidePatchAction(
      input({
        severity: 3,
        reachability: 2,
        attackSurface: 2,
        semverJump: 2,
        testGap: 1,
        rollbackDifficulty: 1,
      })
    );
    expect(result.decision).toBe('urgent_approval');
  });

  it('low urgency × high risk → defer', () => {
    const result = decidePatchAction(
      input({
        severity: 1,
        reachability: 0,
        attackSurface: 1,
        semverJump: 2,
        testGap: 2,
        rollbackDifficulty: 1,
      })
    );
    expect(result.decision).toBe('defer');
  });

  it('moderate urgency × manageable risk → scheduled', () => {
    const result = decidePatchAction(
      input({ severity: 2, reachability: 0, attackSurface: 0, semverJump: 1, testGap: 1 })
    );
    expect(result.decision).toBe('scheduled');
  });

  it('everything else falls back to the fail-safe approval path', () => {
    const result = decidePatchAction(
      input({ severity: 1, reachability: 0, attackSurface: 0, semverJump: 1, testGap: 2 })
    );
    expect(result.decision).toBe('approval');
    expect(result.reason).toContain('fail-safe');
  });

  it('never auto-applies when apply risk exceeds the low-risk band', () => {
    for (let risk = 3; risk <= 9; risk += 1) {
      const result = decidePatchAction(
        input({
          severity: 3,
          reachability: 2,
          attackSurface: 2,
          semverJump: Math.min(3, risk),
          testGap: Math.min(3, Math.max(0, risk - 3)),
          rollbackDifficulty: Math.min(3, Math.max(0, risk - 6)),
        })
      );
      expect(result.decision).not.toBe('auto_apply');
    }
  });
});
