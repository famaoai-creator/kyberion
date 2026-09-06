import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('execution guard environment boundary', () => {
  it('uses the foundation accessor for plugin configuration', () => {
    const source = safeReadFile(pathResolver.rootResolve('plugins/execution-guard.ts'), {
      encoding: 'utf8',
    }) as string;

    expect(source).toContain("getRegisteredEnvText('GUARD_BLOCKED_EXTS')");
    expect(source).toContain("getRegisteredEnvText('GUARD_WARN_DURATION_MS')");
    expect(source).not.toContain('process.env.GUARD_BLOCKED_EXTS');
    expect(source).not.toContain('process.env.GUARD_WARN_DURATION_MS');
  });
});
