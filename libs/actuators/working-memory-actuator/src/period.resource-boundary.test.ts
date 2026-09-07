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
    // Contract updated 2026-09: `readJson` (foundation) delegates to
    // secure-io's `secureLoadJson`, which still runs the raw text through
    // `parseSafeJsonInput` internally (see libs/core/secure-io.ts) plus a
    // guarded `safeReadFile`. Calling `readJson` directly is therefore at
    // least as safe as the previous manual
    // `parseSafeJsonInput(safeReadFile(...))` pairing, so the boundary now
    // requires the higher-level governed reader instead of the raw helper.
    expect(source).toContain('readJson(');
  });
});
