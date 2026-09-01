import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('audit verify entrypoint', () => {
  it('keeps report output and exit policy behind the shared harness', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/audit_verify.ts'), { encoding: 'utf8' })
    );

    expect(source).toContain('context.print(');
    expect(source).toContain('new ScriptExitError(');
    expect(source).not.toContain('console.log(');
    expect(source).not.toContain('console.warn(');
  });
});
