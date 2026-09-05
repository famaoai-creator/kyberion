import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import {
  checkLockfileCommitGate,
  isLockfileChangePermitted,
} from './check_lockfile_commit_gate.js';

describe('lockfile commit gate', () => {
  it('reads CI metadata and review overrides through the environment registry', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/check_lockfile_commit_gate.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toContain('process.env.GITHUB_BASE_REF');
    expect(source).not.toContain('process.env.PI_LOCKFILE_REVIEW_EVIDENCE');
    expect(source).not.toContain('process.env.PI_ALLOW_LOCKFILE_CHANGE');
    expect(source).toContain("getRegisteredEnvText('GITHUB_BASE_REF')");
    expect(source).toContain("getRegisteredEnvText('PI_LOCKFILE_REVIEW_EVIDENCE')");
    expect(source).toContain("getRegisteredEnvText('PI_ALLOW_LOCKFILE_CHANGE')");
  });

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
