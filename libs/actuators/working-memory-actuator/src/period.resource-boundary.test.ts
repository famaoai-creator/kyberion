import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('working-memory period resource boundary', () => {
  it('validates period keys before deriving personal resource paths', () => {
    const source = String(
      safeReadFile(
        pathResolver.rootResolve('libs/actuators/working-memory-actuator/src/index.ts'),
        { encoding: 'utf8' }
      )
    );

    expect(source).toContain('function normalizeDailyPeriod(');
    expect(source).toContain('function normalizeWeeklyPeriod(');
    expect(source).toContain('const journalPath = assertSafeRepositoryPath(');
    expect(source).toContain('const weeklyPath = assertSafeRepositoryPath(');
    expect(source).toContain('parseSafeJsonInput(');
    expect(source).not.toContain('readJson');
  });
});
