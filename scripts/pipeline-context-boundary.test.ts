import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('pipeline context resource boundary', () => {
  it('uses the governed object parser for --context', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/pipeline-execution-part-results.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain(
      "parseSafeJsonObjectInput(argv.context as string, 'pipeline --context')"
    );
    expect(source).not.toContain('JSON.parse(argv.context as string)');
    expect(source).not.toContain('process.env.MISSION_ID ||');
    expect(source).not.toContain(
      'loadPipelineRunJournal(String(argv.resume), process.env.MISSION_ID)'
    );
    expect(source).not.toContain('process.env.NODE_OPTIONS');
    expect(source).not.toContain('process.env.MISSION_ROLE');
    expect(source).toContain("getRegisteredEnvText('MISSION_ID')");
    expect(source).toContain("getRegisteredEnvText('NODE_OPTIONS')");
    expect(source).toContain("setRegisteredEnv('MISSION_ROLE'");
    expect(source).toContain("setRegisteredEnv('MISSION_ID'");
  });
});
