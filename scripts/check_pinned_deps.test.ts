import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { checkPinnedDependencies } from './check_pinned_deps.js';

describe('pinned dependency checker', () => {
  it('uses the foundation text reader for the lockfile', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/check_pinned_deps.ts'), {
        encoding: 'utf8',
      }) || ''
    );
    expect(source).toContain("readTextFile } from '@agent/core/foundation'");
    expect(source).not.toContain('safeReadFile(');
    expect(source).toContain('minimum-release-age');
    expect(source).toContain('minimum-release-age-strict');
  });

  it('keeps the repository package manager, overrides, and lockfile governed', () => {
    expect(checkPinnedDependencies()).toEqual([]);
  });
});
