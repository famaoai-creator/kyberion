import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { loadSoakRestartStateAtPath } from '@agent/core/soak-restart-state';
import { safeExistsSync, safeReadFile, safeRmSync } from '@agent/core/secure-io';
import { runSoakRestartE2E } from './soak_restart_e2e.js';

describe('soak_restart_e2e', () => {
  it('restores state across a kill-and-resume cycle', async () => {
    const root = pathResolver.sharedTmp('soak-endurance/restart-e2e-test');
    safeRmSync(root, { recursive: true, force: true });

    const report = await runSoakRestartE2E(root);

    expect(report.restored).toBe(true);
    expect(safeExistsSync(report.bootstrap.heartbeat_path)).toBe(true);
    expect(safeExistsSync(report.bootstrap.journal_path)).toBe(true);
    expect(safeExistsSync(report.resume.state_path)).toBe(true);
    expect(loadSoakRestartStateAtPath(report.resume.state_path)).toMatchObject({
      healthy: true,
      resumed: true,
      phase: 'resume',
      restored_from: 'bootstrap',
    });
    expect(
      JSON.parse(safeReadFile(report.resume.state_path, { encoding: 'utf8' }) as string)
    ).toMatchObject({ resumed: true, restored_from: 'bootstrap' });
  }, 20000);

  it('rejects a root outside the repository before cleanup', async () => {
    await expect(runSoakRestartE2E('/tmp/kyberion-soak-outside')).rejects.toThrow(
      /RESOURCE_PATH_SCOPE/u
    );
  });

  it('keeps the restart state reader and writer on the canonical contract', async () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/soak_restart_e2e.ts'), { encoding: 'utf8' })
    );
    expect(source).toContain('loadSoakRestartStateAtPath(');
    expect(source).toContain('writeSoakRestartStateAtPath(');
    expect(source).not.toContain('readJson<{ phase?:');
    expect(source).not.toContain('readJson<{ resumed?:');
  });

  it('routes CLI report output through the shared printer', async () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/soak_restart_e2e.ts'), { encoding: 'utf8' })
    );
    expect(source).toContain('run: ({ argv, print }) => main(argv, print)');
    expect(source).not.toContain('console.log(JSON.stringify(report, null, 2))');
  });
});
