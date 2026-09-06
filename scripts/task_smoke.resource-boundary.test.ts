import { describe, expect, it } from 'vitest';

import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('task smoke resource boundary', () => {
  it('validates scenario and generated profile paths', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/task_smoke.ts'), { encoding: 'utf8' })
    );

    expect(source).toContain('assertSafeRepositoryPath(path.join(SCENARIO_DIR');
    expect(source).toContain('safeLstat(filePath).isFile()');
    expect(source).toContain('assertSafeRepositoryPath(path.join(SMOKE_PROFILE_DIR');
    expect(source).toContain('safeMkdir(assertSafeRepositoryPath(SMOKE_PROFILE_DIR');
  });
});
