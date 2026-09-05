import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('run service procedure environment boundary', () => {
  it('routes mission fallback through the governed environment accessor', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/run_service_procedure.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toContain('process.env.MISSION_ID');
    expect(source).toContain("getRegisteredEnvText('MISSION_ID')");
  });
});
