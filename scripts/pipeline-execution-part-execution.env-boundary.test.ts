import { describe, expect, it } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core';

describe('pipeline execution environment boundary', () => {
  it('routes ambient mission reads through the shared registered environment helper', () => {
    const source = readTextFile(
      pathResolver.rootResolve('scripts/pipeline-execution-part-execution.ts')
    );
    expect(source).not.toContain('process.env.MISSION_ID');
    expect(source).toContain("registeredEnv('MISSION_ID')");
    expect(source).toContain("import { readTextFile } from '@agent/core/foundation'");
  });
});
