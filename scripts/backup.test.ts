import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver, safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from '@agent/core';
import {
  parseBackupArgs,
  pruneBackups,
  resolveBackupPlan,
  summarizeBackupStatus,
} from './backup.js';

const FIXTURE_DIR = pathResolver.sharedTmp('backup-test');

describe('backup cli', () => {
  afterEach(() => {
    safeRmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  it('parses create scope and encryption arguments', () => {
    expect(
      parseBackupArgs([
        'create',
        '--scope',
        'tenant',
        '--tenant',
        'acme',
        '--out',
        'active/shared/tmp/acme.tar.gz.enc',
        '--encrypt',
      ])
    ).toMatchObject({
      command: 'create',
      scope: 'tenant',
      tenant: 'acme',
      out: 'active/shared/tmp/acme.tar.gz.enc',
      encrypt: true,
    });
  });

  it('includes all protected roots for full backup planning', () => {
    const plan = resolveBackupPlan({
      scope: 'all',
      rootDir: '/repo',
      pathExists: (repoPath) =>
        ['active', 'vault', 'knowledge/personal', 'knowledge/confidential'].includes(repoPath),
    });

    expect(plan.entries).toEqual([
      'active',
      'knowledge/confidential',
      'knowledge/personal',
      'vault',
    ]);
    expect(plan.includesSensitive).toBe(true);
  });

  it('discovers active and personal mission git repositories for bundle planning', () => {
    safeMkdir(`${FIXTURE_DIR}/active/missions/confidential/MSN-A/.git`);
    safeMkdir(`${FIXTURE_DIR}/knowledge/personal/missions/MSN-B/.git`);

    const plan = resolveBackupPlan({
      scope: 'all',
      rootDir: FIXTURE_DIR,
      pathExists: (repoPath) => safeExistsSync(`${FIXTURE_DIR}/${repoPath}`),
    });

    expect(plan.missionGitRepos.map((repo) => repo.repoRelativePath)).toEqual([
      'active/missions/confidential/MSN-A',
      'knowledge/personal/missions/MSN-B',
    ]);
  });

  it('requires a tenant for tenant backup planning', () => {
    expect(() =>
      resolveBackupPlan({
        scope: 'tenant',
        rootDir: '/repo',
        pathExists: () => false,
      })
    ).toThrow('--tenant/--customer is required');
  });

  it('parses retention options for prune', () => {
    expect(
      parseBackupArgs(['prune', '--dir', 'active/shared/tmp/backups', '--retain-daily', '3'])
    ).toMatchObject({
      command: 'prune',
      backupDir: 'active/shared/tmp/backups',
      retainDaily: 3,
      retainWeekly: 4,
    });
  });

  it('parses restore drill arguments', () => {
    expect(
      parseBackupArgs([
        'drill',
        '--dir',
        'active/shared/exports/backups',
        '--target',
        'active/shared/tmp/drill',
        '--prepare-checkout',
        '--force',
      ])
    ).toMatchObject({
      command: 'drill',
      backupDir: 'active/shared/exports/backups',
      target: 'active/shared/tmp/drill',
      prepareCheckout: true,
      force: true,
    });
  });

  it('prunes backup files beyond retention', () => {
    safeMkdir(FIXTURE_DIR);
    for (let i = 0; i < 4; i += 1) {
      safeWriteFile(`${FIXTURE_DIR}/backup-${i}.tar.gz.enc`, 'x');
    }

    const result = pruneBackups(FIXTURE_DIR, { retainDaily: 1, retainWeekly: 0 });

    expect(result.kept).toHaveLength(1);
    expect(result.deleted).toHaveLength(3);
  });

  it('summarizes latest backup status', () => {
    safeMkdir(FIXTURE_DIR);
    safeWriteFile(`${FIXTURE_DIR}/latest.tar.gz.enc`, 'backup');

    const status = summarizeBackupStatus(FIXTURE_DIR, { now: new Date() });

    expect(status).toMatchObject({
      count: 1,
      latestName: 'latest.tar.gz.enc',
      status: 'fresh',
    });
    expect(status.latestSizeBytes).toBe(6);
  });
});
