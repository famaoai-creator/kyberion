import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import {
  isRegularAuthorityRoleProcedurePath,
  isRegularMissionReviewDiffPath,
} from './mission-orchestration-worker-part-context.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';

describe('mission worker authority-role procedure resource loader', () => {
  it('accepts only existing regular procedure files', () => {
    const fixtureRoot = pathResolver.sharedTmp('authority-role-procedure-loader-test');
    const filePath = path.join(fixtureRoot, 'PROCEDURE.md');
    const directoryPath = path.join(fixtureRoot, 'PROCEDURE-directory.md');
    try {
      safeWriteFile(filePath, '# Procedure\n', { mkdir: true });
      safeMkdir(directoryPath, { recursive: true });

      expect(isRegularAuthorityRoleProcedurePath(filePath)).toBe(true);
      expect(isRegularAuthorityRoleProcedurePath(directoryPath)).toBe(false);
      expect(isRegularAuthorityRoleProcedurePath(path.join(fixtureRoot, 'missing.md'))).toBe(false);
    } finally {
      safeRmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('accepts only existing regular review diff files', () => {
    const fixtureRoot = pathResolver.sharedTmp('mission-review-diff-loader-test');
    const filePath = path.join(fixtureRoot, 'diff.patch');
    const directoryPath = path.join(fixtureRoot, 'diff-directory.patch');
    try {
      safeWriteFile(filePath, 'diff --git a/a b/a\n', { mkdir: true });
      safeMkdir(directoryPath, { recursive: true });

      expect(isRegularMissionReviewDiffPath(filePath)).toBe(true);
      expect(isRegularMissionReviewDiffPath(directoryPath)).toBe(false);
      expect(isRegularMissionReviewDiffPath(path.join(fixtureRoot, 'missing.patch'))).toBe(false);
    } finally {
      safeRmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
