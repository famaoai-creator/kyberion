import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('entity governance checker boundary', () => {
  it('uses the foundation text reader for status and gitignore sources', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/check_entity_governance.ts'), {
        encoding: 'utf8',
      }) || ''
    );

    expect(source).toContain('getRegisteredEnvBool, readTextFile');
    expect(source).not.toContain('safeReadFile(statusPath');
    expect(source).not.toContain('safeReadFile(gitIgnorePath');
  });
});
