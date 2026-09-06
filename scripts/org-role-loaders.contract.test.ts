import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('org role loader boundary', () => {
  it('uses the governed authority and team role indexes', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/org.ts'), { encoding: 'utf8' })
    );
    expect(source).toContain('loadGovernedAuthorityRoleIndex(rootDir)');
    expect(source).toContain('loadGovernedTeamRoleIndex(rootDir)');
    expect(source).not.toMatch(/function readJson<.*>\(/u);
  });

  it('routes organization CLI output through the shared script printer', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/org.ts'), { encoding: 'utf8' })
    );
    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).toContain('run: ({ argv, print }) => main(argv, print)');
  });
});
