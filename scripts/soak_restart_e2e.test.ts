import { describe, expect, it } from 'vitest';
import { pathResolver, safeExistsSync, safeReadFile, safeRmSync } from '@agent/core';
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
    expect(
      JSON.parse(safeReadFile(report.resume.state_path, { encoding: 'utf8' }) as string)
    ).toMatchObject({ resumed: true, restored_from: 'bootstrap' });
  }, 20000);
});
