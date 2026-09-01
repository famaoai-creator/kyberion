import { describe, expect, it } from 'vitest';
import {
  checkLockfileCommitGate,
  isLockfileChangePermitted,
} from './check_lockfile_commit_gate.js';

describe('lockfile commit gate', () => {
  it('accepts the current worktree when no lockfile change is present', () => {
    const result = checkLockfileCommitGate();
    expect(result.changedFiles).not.toContain('pnpm-lock.yaml');
    expect(result.permitted).toBe(true);
  });

  it.each([
    [false, false, false, true],
    [true, false, false, false],
    [true, true, false, false],
    [true, false, true, false],
    [true, true, true, true],
  ])(
    'requires both explicit override and matching evidence when changed=%s',
    (lockfileChanged, allowOverride, hasReviewEvidence, expected) => {
      expect(isLockfileChangePermitted({ lockfileChanged, allowOverride, hasReviewEvidence })).toBe(
        expected
      );
    }
  );
});
