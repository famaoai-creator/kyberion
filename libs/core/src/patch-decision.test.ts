import { describe, expect, it } from 'vitest';
import { computePatchDecisionScores, decidePatchAction } from '../patch-decision.js';

describe('patch decision', () => {
  it('returns auto_apply for urgent low-risk patches', () => {
    const result = decidePatchAction({
      severity: 'critical',
      reachability: 'direct',
      attackSurface: 'external',
      semverJump: 'patch',
      testGap: 'covered',
      rollbackDifficulty: 'easy',
    });

    expect(result.decision).toBe('auto_apply');
    expect(result.urgency).toBeGreaterThan(result.applyRisk);
  });

  it('returns urgent_approval for urgent risky patches', () => {
    const result = decidePatchAction({
      severity: 'critical',
      reachability: 'direct',
      attackSurface: 'external',
      semverJump: 'major',
      testGap: 'thin',
      rollbackDifficulty: 'hard',
    });

    expect(result.decision).toBe('urgent_approval');
  });

  it('returns scheduled for medium-urgency low-risk patches', () => {
    const result = decidePatchAction({
      severity: 'moderate',
      reachability: 'transitive',
      attackSurface: 'internal',
      semverJump: 'patch',
      testGap: 'covered',
      rollbackDifficulty: 'easy',
    });

    expect(result.decision).toBe('scheduled');
  });

  it('returns approval for medium-urgency high-risk patches', () => {
    const result = decidePatchAction({
      severity: 'moderate',
      reachability: 'transitive',
      attackSurface: 'internal',
      semverJump: 'major',
      testGap: 'thin',
      rollbackDifficulty: 'hard',
    });

    expect(result.decision).toBe('approval');
  });

  it('returns defer for low-urgency high-risk patches', () => {
    const result = decidePatchAction({
      severity: 'low',
      reachability: 'none',
      attackSurface: 'local',
      semverJump: 'major',
      testGap: 'thin',
      rollbackDifficulty: 'hard',
    });

    expect(result.decision).toBe('defer');
  });

  it('allows callers to inspect raw scores directly', () => {
    expect(
      computePatchDecisionScores({
        severity: 4,
        reachability: 2,
        attackSurface: 3,
        semverJump: 1,
        testGap: 1,
        rollbackDifficulty: 1,
      })
    ).toEqual({ urgency: 18, applyRisk: 1 });
  });
});
