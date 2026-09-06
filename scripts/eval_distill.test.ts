import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('distill evaluation entrypoint', () => {
  it('keeps deterministic evaluation behind the shared harness boundary', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/eval_distill.ts'), { encoding: 'utf8' })
    );

    expect(source).toContain('context.print(report)');
    expect(source).toContain('new ScriptExitError(');
    expect(source).toContain("isDirectScript(import.meta.url, 'eval_distill.ts')");
    expect(source).not.toContain('process.exitCode');
    expect(source).not.toContain('console.log(');
  });
});
