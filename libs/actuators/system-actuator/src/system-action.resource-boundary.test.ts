import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('system action resource boundary', () => {
  it('revalidates reconcile strategy paths before reading', () => {
    const source = String(
      safeReadFile(
        pathResolver.rootResolve('libs/actuators/system-actuator/src/system-action-helpers.ts'),
        { encoding: 'utf8' }
      )
    );

    expect(source).toContain('const strategyPath = assertSafeRepositoryPath(');
    expect(source).toContain('{ allowMissingLeaf: true }');
  });
});
