import { describe, expect, it } from 'vitest';
import { pathResolver, safeExistsSync, safeReadFile } from '@agent/core';

function read(relativePath: string): string {
  return safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' }) as string;
}

describe('TaskScenario roadmap contract', () => {
  it('links the scenario catalog to the new repeatable task roadmap', () => {
    const catalog = read('docs/SCENARIO_CATALOG.md');

    expect(catalog).toContain('[TASK_SCENARIO_ROADMAP.md](./TASK_SCENARIO_ROADMAP.md)');
    expect(catalog).toContain('Treat `USE_CASES.md` as the source of truth for breadth.');
    expect(catalog).toContain('Use `TASK_SCENARIO_ROADMAP.md` for repeatable task setup flows; it extends, but does not replace, `USE_CASES.md`.');
  });

  it('documents the five initial repeatable task scenarios', () => {
    const roadmapPath = 'docs/TASK_SCENARIO_ROADMAP.md';
    expect(safeExistsSync(pathResolver.rootResolve(roadmapPath))).toBe(true);

    const roadmap = read(roadmapPath);
    for (const scenarioId of [
      'daily-email-triage',
      'meeting-action-items',
      'meeting-to-proposal-pptx',
      'sales-inbound-response',
      'weekly-executive-digest',
    ]) {
      expect(roadmap).toContain(`\`${scenarioId}\``);
    }
  });
});
