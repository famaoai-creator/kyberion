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
    expect(tour).toContain('meeting_participate.ts');
    expect(tour).toContain('voice_consent.ts');
    expect(tour).toContain('run_migrations.ts');
    expect(tour).toContain('verify-session.json');
    expect(tour).toContain('pnpm run test:meeting-dry-run');
    expect(tour).toContain('voice-consent.json');
    expect(tour).toContain('telegram-bridge');
    expect(tour).toContain('customer/{slug}/` becomes the preferred overlay root');
    expect(tour).toContain('Legacy personal fallback');
    expect(tour).toContain('Legacy personal fallback when no customer overlay is active');
    expect(tour).toContain('EXTENSION_POINTS.md');
  });

  it('keeps extension points aligned with the supported CLI and meeting helper boundary', () => {
    const ext = read('docs/developer/EXTENSION_POINTS.md');
    const readme = read('docs/developer/README.md');
    expect(ext).toContain('release:notes');
    expect(ext).toContain('migration:run');
    expect(ext).toContain('doctor:meeting');
    expect(ext).toContain('test:meeting-dry-run');
    expect(ext).toContain('libs/actuators/meeting-browser-driver/');
    expect(ext).toContain('meeting-actuator');
    expect(ext).toContain('voice-consent.json');
    expect(ext).toContain('PLUGIN_AUTHORING.md');
    expect(ext).toContain('Resolution order: customer overlay → legacy personal fallback.');
    expect(ext).toContain('Editing `knowledge/personal/` when `KYBERION_CUSTOMER` is unset');
    expect(ext).toContain('Editing `knowledge/personal/connections/` when `KYBERION_CUSTOMER` is unset');
    expect(ext).toContain('Stable (v1+)');
    expect(ext).toContain('Internal');
    expect(readme).toContain('PLUGIN_AUTHORING.md');
    expect(readme).toContain('Meeting participation runtime');
  });
});
