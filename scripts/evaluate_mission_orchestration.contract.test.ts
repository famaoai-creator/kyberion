import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('mission orchestration evaluation catalog boundary', () => {
  it('uses governed catalogs for scenario runs and evaluation reports', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/evaluate_mission_orchestration.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('defineCatalog<ScenarioRunRecord[]>');
    expect(source).toContain("id: 'mission-orchestration-evaluation-report'");
    expect(source).toContain('assertSafeRepositoryPath(');
    expect(source).toContain("flags: ['json']");
    expect(source).toContain('run: ({ argv, json, print }) => main(argv, print, json)');
    expect(source).not.toContain('console.log(');
    expect(source).not.toContain('createAjv()');
    expect(source).not.toContain('readFoundationJson');
  });
});
