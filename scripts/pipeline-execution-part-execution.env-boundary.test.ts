import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('pipeline execution environment boundary', () => {
  it('routes ambient mission reads through the shared registered environment helper', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/pipeline-execution-part-execution.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).not.toContain('process.env.MISSION_ID');
    expect(source).toContain("registeredEnv('MISSION_ID')");
  });
});
