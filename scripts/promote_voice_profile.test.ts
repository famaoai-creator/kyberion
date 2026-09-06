import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('voice profile promotion entrypoint', () => {
  it('keeps promotion output behind the shared harness boundary', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/promote_voice_profile.ts'), {
        encoding: 'utf8',
      })
    );

    expect(source).toContain('print(result)');
    expect(source).not.toContain('console.log(');
  });
});
