import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('Japanese contextual intent evaluation', () => {
  it('keeps corpus execution behind the shared output and failure boundaries', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/eval_japanese_contextual_intent.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).toContain('context.print(report)');
    expect(source).toContain('new ScriptExitError(');
    expect(source).not.toContain('process.exitCode');
    expect(source).not.toContain('console.log(');
    expect(source).not.toContain('console.error(');
  });
});
