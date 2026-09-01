import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('model feedback entrypoint', () => {
  it('keeps feedback output behind the shared harness boundary', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/model_feedback.ts'), { encoding: 'utf8' })
    );

    expect(source).toContain('print(feedback)');
    expect(source).not.toContain('console.log(');
  });
});
