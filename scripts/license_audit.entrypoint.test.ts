import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('license audit entrypoint', () => {
  it('keeps audit output and check failures behind the shared script harness', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/license_audit.ts'), { encoding: 'utf8' })
    );

    expect(source).toContain("flags: ['json', 'check', 'quiet']");
    expect(source).toContain('context.print(');
    expect(source).toContain('new ScriptExitError(1');
    expect(source).not.toContain('console.log(');
    expect(source).not.toContain('console.error(');
  });
});
