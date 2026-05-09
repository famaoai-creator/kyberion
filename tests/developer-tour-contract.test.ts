import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';

const rootDir = process.cwd();

function read(relPath: string): string {
  return safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
}

describe('Developer tour contract', () => {
  it('keeps the tour aligned with the current core and actuator paths', () => {
    const tour = read('docs/developer/TOUR.md');
    expect(tour).toContain('libs/core/src/pipeline-engine.ts');
    expect(tour).toContain('libs/core/mission-classification.ts');
    expect(tour).toContain('libs/core/mission-team-orchestrator.ts');
    expect(tour).toContain('libs/core/src/intent-compiler.ts');
    expect(tour).toContain('libs/actuators/browser-actuator/src/index.ts');
    expect(tour).toContain('meeting-actuator/');
    expect(tour).toContain('meeting-browser-driver/');
    expect(tour).toContain('EXTENSION_POINTS.md');
  });

  it('keeps extension points aligned with the supported CLI and meeting helper boundary', () => {
    const ext = read('docs/developer/EXTENSION_POINTS.md');
    const readme = read('docs/developer/README.md');
    expect(ext).toContain('release:notes');
    expect(ext).toContain('libs/actuators/meeting-browser-driver/');
    expect(ext).toContain('PLUGIN_AUTHORING.md');
    expect(ext).toContain('Stable (v1+)');
    expect(ext).toContain('Internal');
    expect(readme).toContain('PLUGIN_AUTHORING.md');
  });
});
