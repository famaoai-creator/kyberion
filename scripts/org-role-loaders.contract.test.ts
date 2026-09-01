import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('org role loader boundary', () => {
  it('uses the governed authority and team role indexes', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/org.ts'), { encoding: 'utf8' })
    );
    expect(source).toContain('loadGovernedAuthorityRoleIndex(rootDir)');
    expect(source).toContain('loadGovernedTeamRoleIndex(rootDir)');
  });
});
