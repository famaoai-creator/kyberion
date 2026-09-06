import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

describe('code catalog resource boundary', () => {
  it('revalidates the governed skill index before reading it', () => {
    const source = String(
      safeReadFile(
        pathResolver.rootResolve('libs/actuators/code-actuator/src/code-pipeline-helpers.ts'),
        { encoding: 'utf8' }
      )
    );

    expect(source).toContain('const skillIndexPath = assertSafeRepositoryPath(');
    expect(source).toContain(
      "pathResolver.knowledge('product/orchestration/global_skill_index.json')"
    );
    expect(source).toContain('const parsed = readJson<GlobalSkillIndex>(skillIndexPath);');
    expect(source).toContain("parseSafeJsonInput(stdout, 'semgrep response')");
    expect(source).not.toContain('const parsed = JSON.parse(raw) as GlobalSkillIndex');
  });
});
