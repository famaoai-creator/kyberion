import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('wisdom pipeline resource boundaries', () => {
  it('revalidates resolver-derived knowledge resources at operation time', () => {
    const source = String(
      safeReadFile(
        pathResolver.rootResolve('libs/actuators/wisdom-actuator/src/wisdom-pipeline-helpers.ts'),
        { encoding: 'utf8' }
      )
    );

    expect(source).toContain('const sourcePath = assertSafeRepositoryPath(');
    expect(source).toContain('const sourceFile = assertSafeRepositoryPath(');
    expect(source).toContain('const pkgPath = assertSafeRepositoryPath(');
    expect(source).toContain('const targetFile = assertSafeRepositoryPath(');
  });
});
