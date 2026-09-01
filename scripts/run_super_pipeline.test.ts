import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('super pipeline entrypoint', () => {
  it('keeps result output and failures behind the shared harness', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/run_super_pipeline.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).toContain('context.print(result)');
    expect(source).toContain('new ScriptExitError(');
    expect(source).not.toContain('console.log(');
    expect(source).not.toContain('process.exitCode');
  });
});
