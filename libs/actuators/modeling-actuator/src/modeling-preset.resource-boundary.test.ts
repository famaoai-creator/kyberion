import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('modeling preset resource boundary', () => {
  it('revalidates the browser execution preset catalog before loading it', () => {
    const source = String(
      safeReadFile(
        pathResolver.rootResolve(
          'libs/actuators/modeling-actuator/src/modeling-pipeline-helpers.ts'
        ),
        { encoding: 'utf8' }
      )
    );

    expect(source).toContain('safePresetPath = assertSafeRepositoryPath(');
    expect(source).toContain('readJson<{');
    expect(source).toContain('}>(safePresetPath)');
  });
});
